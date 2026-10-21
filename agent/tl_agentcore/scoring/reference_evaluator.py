"""Reference-validity judge: parse the agent's `<plan>...</plan>` output
(if any) and verify that every cited `asset_id` corresponds to a real
row in the `assets` DynamoDB table. Returns a count-based score plus
the list of missing ids.

Public contract: `judge(response_text, knowledge_store_id) -> dict`
    {"judge": "reference_validity",
     "score": int|None,          # 5 = all refs exist, 1 = none exist
     "justification": str,       # "N/M asset ids resolved"
     "latency_ms": int,
     "missing_asset_ids": list[str],
     "error": str|None}

Deterministic (no model call) — fast and cheap, runs on every judge
tick even when sampling is low on the coherence side.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import boto3  # type: ignore

JUDGE_NAME = "reference_validity"

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_ASSETS_TABLE = os.environ.get("ASSETS_TABLE", "")
_ddb = boto3.client("dynamodb", region_name=_REGION)

# Matches 24-hex ids inside a <plan> block. Asset ids in the EDL are
# always 24 hex (uuid4 trimmed) — we don't need to catch anything else.
_PLAN_BLOCK = re.compile(r"<plan>(.*?)</plan>", re.DOTALL | re.IGNORECASE)
_ASSET_ID = re.compile(r"\b([0-9a-f]{24})\b")


def judge(response_text: str, knowledge_store_id: str | None = None) -> dict[str, Any]:
    t0 = time.perf_counter()
    plan_match = _PLAN_BLOCK.search(response_text or "")
    if not plan_match:
        # No plan to validate — trivially coherent (score 5) with a
        # justification that explains the no-op. Keeps the row shape
        # consistent across judgments.
        return {
            "judge": JUDGE_NAME,
            "score": 5,
            "justification": "no <plan> block in response — nothing to validate",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "missing_asset_ids": [],
            "error": None,
        }

    plan_body = plan_match.group(1)
    cited = sorted(set(_ASSET_ID.findall(plan_body)))
    if not cited:
        return {
            "judge": JUDGE_NAME,
            "score": 5,
            "justification": "<plan> block carried no asset_ids",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "missing_asset_ids": [],
            "error": None,
        }

    if not _ASSETS_TABLE:
        return {
            "judge": JUDGE_NAME,
            "score": None,
            "justification": "ASSETS_TABLE env var not set",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "missing_asset_ids": [],
            "error": "config",
        }

    missing = _lookup_missing(cited)
    present = len(cited) - len(missing)
    score = _score_from_fraction(present, len(cited))
    return {
        "judge": JUDGE_NAME,
        "score": score,
        "justification": f"{present}/{len(cited)} asset ids resolved" +
                          (f" — missing {missing[:5]}" if missing else ""),
        "latency_ms": int((time.perf_counter() - t0) * 1000),
        "missing_asset_ids": missing,
        "error": None,
    }


def _lookup_missing(asset_ids: list[str]) -> list[str]:
    """Return the subset of `asset_ids` with no row in ASSETS_TABLE.
    BatchGetItem is capped at 100 keys per call; chunk accordingly."""
    missing: list[str] = []
    seen: set[str] = set()
    for i in range(0, len(asset_ids), 100):
        chunk = asset_ids[i:i + 100]
        try:
            r = _ddb.batch_get_item(RequestItems={_ASSETS_TABLE: {
                "Keys": [{"asset_id": {"S": aid}} for aid in chunk],
                "ProjectionExpression": "asset_id",
            }})
        except Exception as e:
            # Give up: treat all as unknown rather than lying about
            # presence. The judge row will reflect this via the error
            # path on the runner side.
            raise RuntimeError(f"batch_get_item failed: {e}") from e
        for row in r.get("Responses", {}).get(_ASSETS_TABLE, []):
            aid = row.get("asset_id", {}).get("S")
            if aid:
                seen.add(aid)
    for aid in asset_ids:
        if aid not in seen:
            missing.append(aid)
    return missing


def _score_from_fraction(present: int, total: int) -> int:
    if total <= 0:
        return 5
    frac = present / total
    if frac >= 1.0: return 5
    if frac >= 0.8: return 4
    if frac >= 0.5: return 3
    if frac >= 0.2: return 2
    return 1
