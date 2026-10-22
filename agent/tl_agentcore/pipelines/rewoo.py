"""ReWOO (Reasoning WithOut Observation) executor for info-type turns.

Three stages:

  1. Planner — one Bedrock call. The model sees the user prompt + tool
     catalog and emits a JSON plan: an array of {step_id, tool, args}
     objects. Args may reference earlier step outputs with
     `<step_N>` (whole observation) or `<step_N.field>` (dict field).

  2. Executor — a deterministic loop. For each step, substitute
     variable references, invoke the tool by name, record the result as
     the step's observation. Fire SSE `tool_begin` / `tool_end` events
     so the UI stream looks the same as a ReAct run.

  3. Solver — one Bedrock call. The model sees the user prompt + the
     plan + the observations and composes the final answer.

Why ReWOO:
  - Fixed round-trip count. ReAct spends one model call per thinking
    step; ReWOO spends two (planner + solver) regardless of plan length.
  - The planner never sees tool outputs, so the plan prompt stays small
    and cheap.
  - Natural fit for information-type queries where the agent would
    otherwise call vector_search → pegasus_analyze → lookup → compose
    in a predictable sequence.

Fallback contract:
  - On any executor error (bad tool name, bad args, variable
    substitution miss, tool raise), raise `RewooFallback`. The runtime
    catches it and re-runs the turn through ReAct.
  - The planner response is parsed defensively — a malformed plan →
    RewooFallback with a reason.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from typing import Any, AsyncIterator

import boto3  # type: ignore

from ..metering import record_model_invocation
from .tool_registry import get_tool_catalog, get_tool_registry

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_bedrock = boto3.client("bedrock-runtime", region_name=_REGION)

# Maximum steps a single plan may carry. Larger plans tend to drift —
# the model forgets early-step observations by the time the solver runs.
MAX_PLAN_STEPS = int(os.environ.get("REWOO_MAX_STEPS", "8"))
# Max string length when we serialize an observation into the solver
# prompt. Keeps the composer prompt bounded even if a tool returned a
# multi-megabyte dict.
OBS_TRUNC = int(os.environ.get("REWOO_OBS_TRUNC", "4000"))

# step_N → observation lookup. Also matches dotted field access:
# <step_1.content.0.text> traverses a nested dict/list path.
_VAR_RE = re.compile(r"<\s*step_(\d+)(\.[\w.\[\]0-9]+)?\s*>")


class RewooFallback(Exception):
    """Raised when ReWOO can't complete this turn and the caller should
    re-run via ReAct. The message is a short human-readable reason."""


_PLANNER_PROMPT = """You are the PLANNER stage of a ReWOO agent. Your job is to
emit a JSON plan the executor can run WITHOUT further input from you.

Rules:
  - Output ONLY a JSON array. No prose, no markdown fences, no
    explanation. The top-level must be a list.
  - Each list entry is one step: {{"step_id": <int>, "tool": "<name>",
    "args": {{...}}, "why": "<short reason>"}}.
  - step_id starts at 1 and increments by 1.
  - "tool" must be one of the names in the catalog below. Exact spelling.
  - "args" is a plain JSON object matching the tool's input schema.
  - To reference an earlier step's output, use the placeholder
    "<step_N>" (whole observation) or "<step_N.path.to.field>" (dotted
    field access). Placeholders are substituted literally before the
    tool runs.
  - Keep the plan short: 1 to {max_steps} steps. Prefer fewer.
  - If no tools are needed to answer the prompt (small talk, pure
    reasoning), return an empty array [].

Tool catalog (name — description — args):
{catalog}

User prompt:
{prompt}

{selections}
Emit the JSON plan now.
"""

_SOLVER_PROMPT = """You are the SOLVER stage of a ReWOO agent. Given the user's
original prompt, the plan that ran, and the observations from each
step, compose the final reply to the user.

Guidelines:
  - Answer the user's question directly. No preamble about "I called
    tools" or "here is my plan".
  - Cite values from observations verbatim where accuracy matters
    (asset_ids, timecodes, counts, titles).
  - If an observation is an error, acknowledge the gap and work with
    what remains.
  - If the plan was empty, answer from world knowledge of the agent's
    domain (video editing, EDL schema, TwelveLabs terminology).

User prompt:
{prompt}

Plan + observations (JSON):
{trace}

Write the final reply.
"""


async def run_rewoo(
    *,
    prompt: str,
    user_text: str,
    knowledge_store_id: str | None,
    response_id: str,
    selections: list[dict[str, Any]] | None,
) -> AsyncIterator[dict]:
    """Semantic-event async generator. Yields the same `__kind__`-
    tagged dicts the runtime's ReAct path emits:

      {"__kind__": "text_begin", "item_id": ...}
      {"__kind__": "tool_begin", "tool_use_id", "name", "arguments"}
      {"__kind__": "tool_end",   "tool_use_id", "name", "output"}
      {"__kind__": "text_delta", "item_id", "delta"}
      {"__kind__": "text_done",  "item_id", "text"}

    On an executor error, raises RewooFallback — the caller must catch
    this and re-run the turn through ReAct."""
    catalog = get_tool_catalog()
    registry = get_tool_registry()
    from .. import agent as _a
    user_id = _a._current_user_id()

    # ─── Planner ────────────────────────────────────────────────────
    plan_t0 = time.perf_counter()
    plan = await asyncio.to_thread(
        _plan,
        user_text=user_text,
        catalog=catalog,
        selections=selections or [],
        user_id=user_id,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
    )
    plan_ms = int((time.perf_counter() - plan_t0) * 1000)

    if not isinstance(plan, list):
        raise RewooFallback(f"planner returned non-list: {type(plan).__name__}")
    if len(plan) > MAX_PLAN_STEPS:
        raise RewooFallback(f"planner produced {len(plan)} steps (max {MAX_PLAN_STEPS})")

    text_item_id = f"msg_{uuid.uuid4().hex[:12]}"

    # ─── Executor ───────────────────────────────────────────────────
    observations: dict[int, Any] = {}
    for raw in plan:
        step_id = _as_int(raw.get("step_id"))
        tool_name = raw.get("tool") or ""
        args = raw.get("args") or {}
        if not step_id or not tool_name:
            raise RewooFallback(f"malformed step: {raw!r}")
        if tool_name not in registry:
            raise RewooFallback(f"unknown tool: {tool_name!r}")
        if not isinstance(args, dict):
            raise RewooFallback(f"args must be a dict (step {step_id})")

        try:
            resolved = _substitute(args, observations)
        except KeyError as e:
            raise RewooFallback(f"variable miss in step {step_id}: {e}") from e

        tool_use_id = f"call_{uuid.uuid4().hex[:12]}"
        yield {
            "__kind__": "tool_begin",
            "tool_use_id": tool_use_id,
            "name": tool_name,
            "arguments": resolved,
        }

        tool = registry[tool_name]
        try:
            result = await asyncio.to_thread(tool, **resolved)
        except TypeError as e:
            raise RewooFallback(f"tool {tool_name} bad args: {e}") from e
        except Exception as e:
            # Not every tool exception is terminal; record it and let the
            # solver reason about the gap. If every step errors the
            # solver will say so.
            result = {"error": f"{type(e).__name__}: {e}"}

        observations[step_id] = result
        yield {
            "__kind__": "tool_end",
            "tool_use_id": tool_use_id,
            "name": tool_name,
            "output": _summarize_for_wire(result),
        }

    # ─── Solver ─────────────────────────────────────────────────────
    yield {"__kind__": "text_begin", "item_id": text_item_id}

    solver_t0 = time.perf_counter()
    final_text = await asyncio.to_thread(
        _solve,
        user_text=user_text,
        plan=plan,
        observations=observations,
        user_id=user_id,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
    )
    solver_ms = int((time.perf_counter() - solver_t0) * 1000)

    yield {"__kind__": "text_delta", "item_id": text_item_id, "delta": final_text}
    # text_done is emitted by the runtime's post-pipeline block so both
    # ReAct and ReWOO exit with the same wire shape.

    # One sidecar event the runtime can translate into a response.activity
    # frame so the UI can show pipeline + stage latencies on the trace.
    yield {
        "__kind__": "activity",
        "tool_use_id": response_id,
        "text": f"rewoo: {len(plan)} step(s) · planner {plan_ms} ms · solver {solver_ms} ms",
    }


# ─── Planner ────────────────────────────────────────────────────────────────
def _plan(
    *,
    user_text: str,
    catalog: list[dict[str, Any]],
    selections: list[dict[str, Any]],
    user_id: str | None,
    response_id: str,
    knowledge_store_id: str | None,
) -> list[dict[str, Any]]:
    cat_lines = []
    for t in catalog:
        argbits = ", ".join(
            f"{a['name']}:{a['type']}{'' if a['required'] else '?'}"
            for a in t["args"]
        )
        cat_lines.append(f"- {t['name']}({argbits}) — {t['description']}")
    sel_hint = ""
    if selections:
        sel_hint = (
            "The user has a working set selected; prefer tools that take "
            "the selected asset_id / bounds over fresh retrieval:\n"
            + json.dumps(selections[:4])
            + "\n"
        )
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "temperature": 0.0,
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": _PLANNER_PROMPT.format(
                catalog="\n".join(cat_lines),
                prompt=user_text[:6000],
                max_steps=MAX_PLAN_STEPS,
                selections=sel_hint,
            )}],
        }],
    }
    from .. import agent as _a
    t0 = time.perf_counter()
    try:
        r = _bedrock.invoke_model(
            modelId=_a.MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(r["body"].read())
    except Exception as e:
        raise RewooFallback(f"planner invoke_model failed: {e}") from e
    latency_ms = int((time.perf_counter() - t0) * 1000)
    text = payload.get("content", [{}])[0].get("text", "")
    usage = payload.get("usage") or {}
    record_model_invocation(
        user_id=user_id,
        model_id=_a.MODEL_ID,
        input_tokens=int(usage.get("input_tokens", 0)),
        output_tokens=int(usage.get("output_tokens", 0)),
        latency_ms=latency_ms,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
    )

    plan = _parse_plan_json(text)
    if plan is None:
        raise RewooFallback("planner returned non-JSON")
    return plan


def _parse_plan_json(text: str) -> list[Any] | None:
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        if t.endswith("```"):
            t = t[:-3]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    # Last resort: find the outermost JSON array.
    start = t.find("[")
    end = t.rfind("]")
    if 0 <= start < end:
        try:
            return json.loads(t[start:end + 1])
        except json.JSONDecodeError:
            return None
    return None


# ─── Executor variable substitution ────────────────────────────────────────
def _substitute(obj: Any, observations: dict[int, Any]) -> Any:
    """Walk `obj` recursively and replace `<step_N>` / `<step_N.field>`
    placeholders inside strings with the corresponding observation
    value. Non-string values pass through unchanged. KeyError is raised
    on a reference to a step that hasn't run yet or a missing field."""
    if isinstance(obj, dict):
        return {k: _substitute(v, observations) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_substitute(v, observations) for v in obj]
    if isinstance(obj, str):
        return _substitute_string(obj, observations)
    return obj


def _substitute_string(s: str, observations: dict[int, Any]) -> Any:
    """A placeholder that fills the entire string is replaced with the
    raw object (preserves types for the tool call). A placeholder inside
    a larger string is stringified and spliced."""
    m = _VAR_RE.fullmatch(s.strip())
    if m:
        return _resolve_var(m, observations)

    def _one(match: re.Match) -> str:
        v = _resolve_var(match, observations)
        return v if isinstance(v, str) else json.dumps(v)

    return _VAR_RE.sub(_one, s)


def _resolve_var(m: re.Match, observations: dict[int, Any]) -> Any:
    idx = int(m.group(1))
    if idx not in observations:
        raise KeyError(f"step_{idx} has no observation yet")
    cur: Any = observations[idx]
    path = (m.group(2) or "").lstrip(".")
    if not path:
        return cur
    for seg in path.split("."):
        # Allow numeric indices for list access.
        if isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
            continue
        if isinstance(cur, list):
            try:
                cur = cur[int(seg)]
                continue
            except (ValueError, IndexError) as e:
                raise KeyError(f"step_{idx} list index {seg!r} invalid: {e}") from e
        raise KeyError(f"step_{idx} field {seg!r} not found")
    return cur


# ─── Solver ─────────────────────────────────────────────────────────────────
def _solve(
    *,
    user_text: str,
    plan: list[dict[str, Any]],
    observations: dict[int, Any],
    user_id: str | None,
    response_id: str,
    knowledge_store_id: str | None,
) -> str:
    trace = {
        "plan": plan,
        "observations": {str(k): _trunc_for_prompt(v) for k, v in observations.items()},
    }
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "temperature": 0.3,
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": _SOLVER_PROMPT.format(
                prompt=user_text[:6000],
                trace=json.dumps(trace, default=str)[:16000],
            )}],
        }],
    }
    from .. import agent as _a
    t0 = time.perf_counter()
    try:
        r = _bedrock.invoke_model(
            modelId=_a.MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(r["body"].read())
    except Exception as e:
        raise RewooFallback(f"solver invoke_model failed: {e}") from e
    latency_ms = int((time.perf_counter() - t0) * 1000)
    usage = payload.get("usage") or {}
    record_model_invocation(
        user_id=user_id,
        model_id=_a.MODEL_ID,
        input_tokens=int(usage.get("input_tokens", 0)),
        output_tokens=int(usage.get("output_tokens", 0)),
        latency_ms=latency_ms,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
    )
    return payload.get("content", [{}])[0].get("text", "")


# ─── Helpers ────────────────────────────────────────────────────────────────
def _as_int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _summarize_for_wire(result: Any) -> str:
    if isinstance(result, dict):
        s = json.dumps(result, default=str)
    elif isinstance(result, (list, tuple)):
        s = json.dumps(list(result), default=str)
    else:
        s = str(result)
    return s[:1200]


def _trunc_for_prompt(v: Any) -> Any:
    if isinstance(v, str) and len(v) > OBS_TRUNC:
        return v[:OBS_TRUNC] + f"\n…[truncated, orig {len(v)} chars]"
    if isinstance(v, (dict, list)):
        s = json.dumps(v, default=str)
        if len(s) > OBS_TRUNC:
            return s[:OBS_TRUNC] + f"\n…[truncated, orig {len(s)} chars]"
        return v
    return v
