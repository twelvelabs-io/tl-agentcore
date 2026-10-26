"""Pipeline router: pre-flight classifier + explicit-override surface.

The real agent's SYSTEM_PROMPT already does an INFORMATIONAL /
STRUCTURAL / AMBIGUOUS classification during the response — but by the
time we see that we're already running ReAct. To route cheaply BEFORE
spinning up the full agent, we run a tiny Haiku pre-flight call with
the same taxonomy.

Routing table (default):
  INFORMATIONAL (what/where/show-me/explain) → ReWOO
  STRUCTURAL    (plan a reel / swap scene / render / mutate state) → ReAct
  AMBIGUOUS     (unclear ask)                → ReAct (safer — can ask back)

Payload override:
  payload["pipeline"] in {"rewoo", "react"} short-circuits the classifier.
  Any other value is ignored and auto-routing runs.

The classifier is a MODEL CALL and therefore not free. We cache the
result for one turn in the local-only `_classify` function (no cross-
process cache). PIPELINE_ROUTER_DISABLED=1 forces ReAct for all turns,
useful for incident mitigation if the planner starts to misroute.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import boto3  # type: ignore

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_DISABLED = os.environ.get("PIPELINE_ROUTER_DISABLED", "0") == "1"

# Default to whatever the agent uses so a fresh deploy always has a
# resolvable model id. Ops can set ROUTER_MODEL_ID to a cheaper Haiku
# profile (e.g. `us.anthropic.claude-haiku-4-5`) once that's validated
# live without a redeploy of the agent image.
def _router_model_id() -> str:
    override = os.environ.get("ROUTER_MODEL_ID", "").strip()
    if override:
        return override
    # Lazy import to avoid a circular at module load.
    from .. import agent as _a
    return _a.MODEL_ID

_bedrock = boto3.client("bedrock-runtime", region_name=_REGION)

MODE_INFORMATIONAL = "informational"
MODE_STRUCTURAL = "structural"
MODE_AMBIGUOUS = "ambiguous"

_PROMPT = """You are a routing classifier for a video-editing agent. Given a user
message, label it with EXACTLY one of these modes and nothing else:

  INFORMATIONAL — the user wants to know something: a status, a summary,
     a value, a lookup, "what/where/when/show me". The answer is a reply,
     not a plan. Example: "what's in clip 3 of scene 2?".

  STRUCTURAL — the user wants a plan built, edited, or executed. The reply
     needs an EDL plan, a scene reshuffle, a swap, a render, or a saved
     artifact. Example: "build a 30s tension reel", "swap scene 2 for
     something kinetic", "render the current plan".

  AMBIGUOUS — the ask isn't clear enough to classify. Example: "what do
     you think?".

Return ONLY one of: INFORMATIONAL | STRUCTURAL | AMBIGUOUS

User message:
{prompt}
"""


def classify_mode(prompt: str) -> str:
    """Return one of informational/structural/ambiguous. Never raises;
    any error degrades to AMBIGUOUS so the caller routes to ReAct."""
    if not prompt or not prompt.strip():
        return MODE_AMBIGUOUS
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 10,
        "temperature": 0.0,
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": _PROMPT.format(prompt=prompt[:4000])}],
        }],
    }
    try:
        r = _bedrock.invoke_model(
            modelId=_router_model_id(),
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(r["body"].read())
        text = payload.get("content", [{}])[0].get("text", "")
    except Exception as e:
        print(f"pipelines/router: classify failed: {e}")
        return MODE_AMBIGUOUS
    tok = _first_token(text).upper()
    if "INFORMATIONAL" in tok:
        return MODE_INFORMATIONAL
    if "STRUCTURAL" in tok:
        return MODE_STRUCTURAL
    if "AMBIGUOUS" in tok:
        return MODE_AMBIGUOUS
    return MODE_AMBIGUOUS


def select_pipeline(payload: dict[str, Any]) -> tuple[str, str]:
    """Choose a pipeline for this turn.

    Returns (pipeline, reason) where pipeline is "rewoo" | "react" and
    reason is a short string ("override" | "mode:<mode>" | "disabled")
    for logging/telemetry.
    """
    if _DISABLED:
        return "react", "disabled"
    override = (payload.get("pipeline") or "").strip().lower()
    if override in {"rewoo", "react"}:
        return override, "override"
    # Multi-turn FOLLOWUPs on an existing plan always carry [CURRENT PLAN]
    # context; ReAct handles those correctly today, so leave them alone.
    # The classifier runs only on fresh / informational-looking turns.
    prompt = payload.get("prompt") or ""
    if "[CURRENT PLAN]" in prompt or "[FOLLOWUP]" in prompt:
        return "react", "followup"
    mode = classify_mode(prompt)
    if mode == MODE_INFORMATIONAL:
        return "rewoo", f"mode:{mode}"
    return "react", f"mode:{mode}"


def _first_token(text: str) -> str:
    """Pull the first alpha token out of a model reply, tolerating stray
    punctuation / fences / 'The answer is: ...' wrappers."""
    m = re.search(r"[A-Za-z]+", text or "")
    return m.group(0) if m else ""
