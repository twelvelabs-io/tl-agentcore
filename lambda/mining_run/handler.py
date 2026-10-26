"""Mining-run Lambda — executes one jockey_plan run (PR #10 of Jockey parity).

Trigger shapes
--------------
1. EventBridge Scheduler fires `{"plan_id": "<id>"}` on the plan's cron/rate.
2. Agent calls `jockey_run(plan_id)` which `lambda:Invoke`s this handler
   synchronously with the same payload shape and reads back the result.

Both paths share the same inner `_execute_plan`.

Flow
----
1. Load the plan row from `JOCKEY_PLANS_TABLE` by plan_id. If disabled or
   missing, fail fast with a jockey_runs entry.
2. Call `bedrock-agentcore:InvokeAgentRuntime` against the configured
   `AGENT_RUNTIME_ARN` with the plan's saved `prompt` + `knowledge_store_id`.
3. Drain the response stream (each frame is a JSON event) and keep the last
   `result` event's text.
4. Write a jockey_runs row keyed by (plan_id, run_id). run_id is an
   ISO-timestamp-prefixed UUID so range queries sort newest-first naturally.
5. Return the run_id + status (+ truncated result text) to the invoker.

Mission-critical: this never retries internally. One invocation = one run
row. EventBridge Scheduler's own retry policy owns the retry story.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3

log = logging.getLogger()
log.setLevel(logging.INFO)

PLANS_TABLE          = os.environ["JOCKEY_PLANS_TABLE"]
RUNS_TABLE           = os.environ["JOCKEY_RUNS_TABLE"]
# AGENT_RUNTIME_ARN is empty on first terraform apply (2-stage: variable
# `agent_runtime_arn` breaks the plans-Lambda ↔ agent-runtime cycle). The
# Lambda startup must survive that empty value and fail per-invoke instead,
# so the operator can see the actionable error in the jockey_runs row.
AGENT_RUNTIME_ARN    = os.environ.get("AGENT_RUNTIME_ARN", "")
RUN_TTL_DAYS         = int(os.environ.get("JOCKEY_RUN_TTL_DAYS", "30"))
RESULT_PREVIEW_CHARS = int(os.environ.get("JOCKEY_RESULT_PREVIEW_CHARS", "4000"))

_ddb = boto3.client("dynamodb")
_agentcore = boto3.client("bedrock-agentcore")


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _load_plan(plan_id: str) -> dict | None:
    r = _ddb.get_item(TableName=PLANS_TABLE, Key={"plan_id": {"S": plan_id}})
    item = r.get("Item")
    if not item:
        return None
    out: dict = {}
    for k, v in item.items():
        out[k] = v.get("S") or v.get("N") or v.get("BOOL")
    return out


def _put_run(
    plan_id: str,
    run_id: str,
    status: str,
    started_at: str,
    completed_at: str,
    result_text: str = "",
    error: str = "",
    tool_path: str = "",
) -> None:
    expires = int(time.time()) + RUN_TTL_DAYS * 86400
    item: dict = {
        "plan_id":      {"S": plan_id},
        "run_id":       {"S": run_id},
        "status":       {"S": status},
        "started_at":   {"S": started_at},
        "completed_at": {"S": completed_at},
        "expires_at":   {"N": str(expires)},
    }
    if result_text:
        item["result_text"] = {"S": result_text[:RESULT_PREVIEW_CHARS]}
    if error:
        item["error"] = {"S": error[:1000]}
    if tool_path:
        item["tool_path"] = {"S": tool_path}
    _ddb.put_item(TableName=RUNS_TABLE, Item=item)


def _invoke_agent(ks: str, prompt: str) -> tuple[str, str]:
    """Call AgentCore runtime, drain the stream, return (text, tool_path)."""
    if not AGENT_RUNTIME_ARN:
        raise RuntimeError(
            "AGENT_RUNTIME_ARN env var is empty — the second terraform apply "
            "with -var agent_runtime_arn=... has not run yet. See mining.tf."
        )
    session_id = f"mining-run-{uuid.uuid4().hex}"  # >33 chars required
    payload = json.dumps({"knowledge_store_id": ks, "prompt": prompt}).encode()
    resp = _agentcore.invoke_agent_runtime(
        agentRuntimeArn=AGENT_RUNTIME_ARN,
        runtimeSessionId=session_id,
        payload=payload,
    )
    body = resp.get("response") or resp.get("body")
    final_text = ""
    tool_path = ""
    for raw in body.iter_lines() if hasattr(body, "iter_lines") else _iter_chunks(body):
        if not raw:
            continue
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
        # SSE frames start with "data: "; strip when present
        if line.startswith("data:"):
            line = line[len("data:"):].strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "result":
            final_text = event.get("text") or final_text
            tool_path = event.get("tool_path") or tool_path
        elif event.get("type") == "error":
            raise RuntimeError(event.get("message") or "agent error")
    return final_text, tool_path


def _iter_chunks(body: Any):
    """Fallback framing for non-iter_lines bodies: yield one chunk at a time."""
    data = body.read() if hasattr(body, "read") else body
    if isinstance(data, (bytes, bytearray)):
        for part in data.split(b"\n"):
            yield part
    else:
        for part in str(data).split("\n"):
            yield part


def _execute_plan(plan_id: str) -> dict:
    started = _utcnow_iso()
    run_id = f"{started}-{uuid.uuid4().hex[:8]}"
    plan = _load_plan(plan_id)
    if plan is None:
        _put_run(plan_id, run_id, "failed", started, _utcnow_iso(),
                 error=f"plan {plan_id} not found")
        return {"plan_id": plan_id, "run_id": run_id, "status": "failed",
                "error": "plan not found"}
    if plan.get("enabled") is False:
        _put_run(plan_id, run_id, "skipped", started, _utcnow_iso(),
                 error="plan disabled")
        return {"plan_id": plan_id, "run_id": run_id, "status": "skipped",
                "reason": "plan disabled"}
    prompt = plan.get("prompt") or ""
    ks = plan.get("knowledge_store_id") or ""
    if not prompt or not ks:
        _put_run(plan_id, run_id, "failed", started, _utcnow_iso(),
                 error="plan missing prompt or ks")
        return {"plan_id": plan_id, "run_id": run_id, "status": "failed",
                "error": "plan missing prompt or ks"}
    try:
        text, tool_path = _invoke_agent(ks, prompt)
    except Exception as e:
        log.exception("agent invoke failed for plan %s", plan_id)
        _put_run(plan_id, run_id, "failed", started, _utcnow_iso(),
                 error=str(e))
        return {"plan_id": plan_id, "run_id": run_id, "status": "failed",
                "error": str(e)}
    _put_run(plan_id, run_id, "succeeded", started, _utcnow_iso(),
             result_text=text, tool_path=tool_path)
    return {
        "plan_id": plan_id,
        "run_id": run_id,
        "status": "succeeded",
        "result_preview": text[:RESULT_PREVIEW_CHARS],
        "tool_path": tool_path,
    }


def handler(event: dict, _context: Any = None) -> dict:
    log.info("mining-run event: %s", json.dumps(event)[:500])
    plan_id = event.get("plan_id") or (event.get("detail") or {}).get("plan_id")
    if not plan_id:
        return {"status": "failed", "error": "missing plan_id in event"}
    return _execute_plan(plan_id)
