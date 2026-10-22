"""Orchestrator: at end-of-turn, decide whether to judge, invoke each
judge, and persist results to the DDB `scores` table.

Entry point: `maybe_judge_turn(prompt, response_text, response_id,
knowledge_store_id, user_id)` — asyncio.create_task-safe. Fire-and-
forget: any failure logs and returns, never raises up to the caller.

Sampling:
  JUDGE_SAMPLE_RATE env var, float in [0.0, 1.0], default 1.0 during
  the calibration window (per the wave-2 memory decision). 0.0 disables
  entirely; useful for local dev.

Row shape (one per judge, so 2 rows per judged turn):
  {
    "response_id":    "<pk>",     # from the agent turn
    "judge_name":     "<sk>",     # coherence | reference_validity
    "score":          <int 1-5 | None>,
    "justification":  "<str>",
    "latency_ms":     <int>,
    "sampled_at":     "<ISO8601>",
    "user_id":        "<cognito sub | 'anonymous'>",
    "knowledge_store_id": "<ks_...>",
    "error":          "<nullable string>",
    "expires_at":     <epoch_seconds>,  # 90-day TTL
  }
"""
from __future__ import annotations

import asyncio
import os
import random
import time
from datetime import datetime, timezone
from typing import Any

import boto3  # type: ignore

from . import coherence_judge, reference_evaluator

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_SCORES_TABLE = os.environ.get("SCORES_TABLE", "")
_SAMPLE_RATE = float(os.environ.get("JUDGE_SAMPLE_RATE", "1.0"))
_TTL_DAYS = 90
_ddb = boto3.client("dynamodb", region_name=_REGION)


def _should_sample() -> bool:
    """Return True on JUDGE_SAMPLE_RATE fraction of calls. 0.0 disables,
    1.0 always samples (calibration mode)."""
    try:
        rate = max(0.0, min(1.0, float(_SAMPLE_RATE)))
    except (TypeError, ValueError):
        return False
    if rate <= 0.0:
        return False
    if rate >= 1.0:
        return True
    return random.random() < rate


def maybe_judge_turn(
    *,
    prompt: str,
    response_text: str,
    response_id: str,
    knowledge_store_id: str | None,
    user_id: str | None,
) -> None:
    """Fire-and-forget. If sampling says yes AND SCORES_TABLE is
    configured, spawn an asyncio task that runs both judges and writes
    their rows. Returns immediately."""
    if not _SCORES_TABLE:
        return
    if not _should_sample():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(_run_judges(
        prompt=prompt,
        response_text=response_text,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
        user_id=user_id,
    ))


async def _run_judges(
    *,
    prompt: str,
    response_text: str,
    response_id: str,
    knowledge_store_id: str | None,
    user_id: str | None,
) -> None:
    sampled_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    expires_at = int(time.time()) + _TTL_DAYS * 86400
    uid = user_id or "anonymous"
    ks = knowledge_store_id or ""

    # Both judges run in threads so the asyncio loop isn't blocked by
    # the Bedrock call. The reference judge is deterministic + fast; the
    # coherence judge is ~1-3s per turn.
    try:
        results = await asyncio.gather(
            asyncio.to_thread(coherence_judge.judge, prompt, response_text),
            asyncio.to_thread(reference_evaluator.judge, response_text, knowledge_store_id),
            return_exceptions=True,
        )
    except Exception as e:
        print(f"judge_runner: gather failed: {e}")
        return

    for res in results:
        if isinstance(res, BaseException):
            print(f"judge_runner: judge raised: {res}")
            continue
        try:
            _put_score_row(
                row=res,
                response_id=response_id,
                sampled_at=sampled_at,
                expires_at=expires_at,
                user_id=uid,
                knowledge_store_id=ks,
            )
        except Exception as e:
            print(f"judge_runner: put_score_row failed for {res.get('judge')}: {e}")


def _put_score_row(
    *,
    row: dict[str, Any],
    response_id: str,
    sampled_at: str,
    expires_at: int,
    user_id: str,
    knowledge_store_id: str,
) -> None:
    item: dict[str, Any] = {
        "response_id":        {"S": response_id or "unknown"},
        "judge_name":         {"S": row.get("judge", "unknown")},
        "sampled_at":         {"S": sampled_at},
        "user_id":            {"S": user_id},
        "knowledge_store_id": {"S": knowledge_store_id},
        "expires_at":         {"N": str(expires_at)},
        "latency_ms":         {"N": str(int(row.get("latency_ms") or 0))},
    }
    score = row.get("score")
    if score is not None:
        item["score"] = {"N": str(int(score))}
    justification = row.get("justification") or ""
    if justification:
        item["justification"] = {"S": justification[:800]}
    err = row.get("error")
    if err:
        item["error"] = {"S": str(err)[:300]}
    missing = row.get("missing_asset_ids")
    if missing:
        item["missing_asset_ids"] = {"SS": [str(m) for m in missing[:50]]}
    _ddb.put_item(TableName=_SCORES_TABLE, Item=item)
