"""Coherence judge: given the user's prompt + the agent's final response,
return a 1-5 score + one-sentence justification. Uses Sonnet 4.6 (same
model identity as the agent so judgments stay in-idiolect).

Public contract: `judge(prompt, response_text) -> dict` returning
    {"judge": "coherence", "score": int|None, "justification": str,
     "latency_ms": int, "error": str|None}

Never raises — any error is captured in the returned dict so the
runner's fire-and-forget path stays simple.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

import boto3  # type: ignore

JUDGE_NAME = "coherence"

# Deliberately short — judges should be cheap. Keep the rubric tight so
# scores stay comparable across versions. Any wording change here is
# effectively a schema change; bump the memory ledger if so.
_PROMPT_TEMPLATE = """You are an evaluator scoring a conversational agent's answer for coherence with the user's prompt.

Return ONLY valid JSON with these fields and no prose around it:
  {{"score": <int 1-5>, "justification": "<one short sentence>"}}

Rubric:
  5 = direct, complete, on-topic answer to the user's actual question.
  4 = on-topic answer that misses a secondary ask or is slightly verbose.
  3 = partially addresses the prompt; omits a core piece.
  2 = tangentially related; mostly off-topic.
  1 = incoherent, non-sequitur, or refuses without justification.

User prompt:
{prompt}

Agent response:
{response}
"""

_MODEL_ID = os.environ.get("JUDGE_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
_REGION = os.environ.get("AWS_REGION", "us-east-1")
_bedrock = boto3.client("bedrock-runtime", region_name=_REGION)


def judge(prompt: str, response_text: str) -> dict[str, Any]:
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 150,
        "temperature": 0.0,
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": _PROMPT_TEMPLATE.format(
                prompt=(prompt or "").strip()[:4000],
                response=(response_text or "").strip()[:8000],
            )}],
        }],
    }
    t0 = time.perf_counter()
    try:
        r = _bedrock.invoke_model(
            modelId=_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(r["body"].read())
        text = payload.get("content", [{}])[0].get("text", "")
        parsed = _parse_json(text)
        return {
            "judge": JUDGE_NAME,
            "score": _coerce_score(parsed.get("score")),
            "justification": str(parsed.get("justification", ""))[:500],
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "error": None,
        }
    except Exception as e:
        return {
            "judge": JUDGE_NAME,
            "score": None,
            "justification": "",
            "latency_ms": int((time.perf_counter() - t0) * 1000),
            "error": f"{type(e).__name__}: {e}"[:300],
        }


def _parse_json(text: str) -> dict:
    """The model is instructed to return pure JSON; be defensive about
    stray markdown fences or prose wrappers."""
    t = (text or "").strip()
    if t.startswith("```"):
        # Strip ```json\n ... \n``` fence.
        t = t.split("\n", 1)[-1]
        if t.endswith("```"):
            t = t[:-3]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        # Last resort: find the first { ... } substring.
        start = t.find("{")
        end = t.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(t[start:end + 1])
            except json.JSONDecodeError:
                pass
    return {}


def _coerce_score(v: Any) -> int | None:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 5 else None
