"""DynamoDB writer for the usage_events ledger.

Row shape (one per metering event):
  {
    "user_id":        <pk, cognito sub | 'anonymous'>,
    "event_id":       <sk, ULID-ish: iso_ts + '_' + uuid8>,
    "event_type":     "model_invoke" | "tool_call",
    "sampled_at":     <iso8601>,
    "response_id":    <agent turn id>,
    "knowledge_store_id": <ks_id or ''>,
    # model_invoke only:
    "model_id":       <bedrock model id>,
    "input_tokens":   <int>,
    "output_tokens":  <int>,
    "cost_usd":       <float | null>,       # null when price missing
    "price_source":   <'ssm:/.../model_id' | 'none'>,
    "latency_ms":     <int>,
    # tool_call only:
    "tool_name":      <string>,
    "duration_ms":    <int>,
    # TTL:
    "expires_at":     <epoch_seconds, 90d>,
  }

Both writers are fire-and-forget. Any exception logs and returns —
metering must never affect the user-facing response path.
"""
from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3  # type: ignore

from .prices import compute_cost_usd, price_for_model

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_TABLE = os.environ.get("USAGE_EVENTS_TABLE", "")
_TTL_DAYS = 90

_ddb = boto3.client("dynamodb", region_name=_REGION)


def _event_id(sampled_at: str) -> str:
    # Lex-sortable sk: iso timestamp + short random tail. Range queries
    # by (user_id, event_id) sort chronologically.
    return f"{sampled_at}_{uuid.uuid4().hex[:8]}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def record_model_invocation(
    *,
    user_id: str | None,
    model_id: str,
    input_tokens: int,
    output_tokens: int,
    latency_ms: int,
    response_id: str,
    knowledge_store_id: str | None,
) -> None:
    """One row per Bedrock model turn. Cost is derived from the
    SSM-backed price lookup; a missing price yields cost_usd=null and
    price_source='none'. Never raises."""
    if not _TABLE:
        return
    try:
        sampled_at = _now_iso()
        expires_at = int(time.time()) + _TTL_DAYS * 86400
        price = price_for_model(model_id)
        cost = compute_cost_usd(input_tokens, output_tokens, price)
        item: dict[str, Any] = {
            "user_id":            {"S": user_id or "anonymous"},
            "event_id":           {"S": _event_id(sampled_at)},
            "event_type":         {"S": "model_invoke"},
            "sampled_at":         {"S": sampled_at},
            "response_id":        {"S": response_id or "unknown"},
            "knowledge_store_id": {"S": knowledge_store_id or ""},
            "model_id":           {"S": model_id or "unknown"},
            "input_tokens":       {"N": str(max(0, int(input_tokens)))},
            "output_tokens":      {"N": str(max(0, int(output_tokens)))},
            "latency_ms":         {"N": str(max(0, int(latency_ms)))},
            "price_source":       {"S": (price or {}).get("source", "none")},
            "expires_at":         {"N": str(expires_at)},
        }
        if cost is not None:
            item["cost_usd"] = {"N": _dec(cost)}
        _ddb.put_item(TableName=_TABLE, Item=item)
    except Exception as e:
        print(f"metering/ledger: record_model_invocation failed: {e}")


def record_tool_call(
    *,
    user_id: str | None,
    tool_name: str,
    duration_ms: int,
    response_id: str,
    knowledge_store_id: str | None,
) -> None:
    """One row per in-process tool call. Cost is intentionally not
    computed here — tool-side spend (Bedrock embedding calls, Pegasus
    seconds, MediaConvert minutes) is already captured by whatever
    AWS service meters it; writing a zero would be misleading. Never
    raises."""
    if not _TABLE:
        return
    try:
        sampled_at = _now_iso()
        expires_at = int(time.time()) + _TTL_DAYS * 86400
        item: dict[str, Any] = {
            "user_id":            {"S": user_id or "anonymous"},
            "event_id":           {"S": _event_id(sampled_at)},
            "event_type":         {"S": "tool_call"},
            "sampled_at":         {"S": sampled_at},
            "response_id":        {"S": response_id or "unknown"},
            "knowledge_store_id": {"S": knowledge_store_id or ""},
            "tool_name":          {"S": tool_name or "unknown"},
            "duration_ms":        {"N": str(max(0, int(duration_ms)))},
            "expires_at":         {"N": str(expires_at)},
        }
        _ddb.put_item(TableName=_TABLE, Item=item)
    except Exception as e:
        print(f"metering/ledger: record_tool_call failed: {e}")


def _dec(x: float) -> str:
    # DDB N type takes a string; keep trailing precision reasonable.
    return f"{x:.10f}".rstrip("0").rstrip(".") or "0"
