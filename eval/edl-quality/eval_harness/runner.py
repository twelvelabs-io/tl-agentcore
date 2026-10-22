"""Agent invocation. Keeps the agent-build and I/O glue out of
scorer.py so the scoring code stays pure.

Two run modes planned:

- `local` (shipped) — imports and calls `tl_agentcore.agent.build_agent`
  directly. Fast, no network, no auth; but doesn't exercise the
  runtime wrapper (preseed, ReWOO router, judges). Fine for prompt-
  engineering iteration where only the ReAct body matters.

- `deployed` (not shipped) — opens a WS to the deployed AgentCore
  Runtime, drives it with the brief, reads the final text. The real
  path. Needs a Cognito test user. Stub below documents the shape so
  the next hand can land it in a follow-up.

Reference-free scoring works on either mode; reference-aware scoring
only matters if you've curated reference EDLs.
"""
from __future__ import annotations

import sys
import time
from typing import Any


def run_local(brief: dict) -> dict[str, Any]:
    """Invoke the Strands agent in-process and return the result bundle
    (user_prompt, response_text, elapsed_ms). Raises on build failure
    so the harness can mark the brief as a hard error rather than
    scoring an empty response."""
    try:
        from tl_agentcore.agent import build_agent  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "run_local requires the agent env — run from `agent/` with "
            "its uv venv active, or pip install -e ../agent."
        ) from e

    ks  = brief.get("knowledge_store_id") or ""
    txt = brief.get("brief") or ""
    if not ks:
        raise ValueError(f"brief {brief.get('id')!r} missing knowledge_store_id")
    if not txt:
        raise ValueError(f"brief {brief.get('id')!r} missing brief text")

    agent, mode = build_agent()
    user_text = f"[ks: {ks}]\n{txt}"
    t0 = time.perf_counter()
    try:
        result = agent(user_text)
    except Exception as e:
        return {
            "mode":          f"local/{mode}",
            "user_prompt":   user_text,
            "response_text": "",
            "elapsed_ms":    int((time.perf_counter() - t0) * 1000),
            "error":         f"{type(e).__name__}: {e}",
        }
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    response_text = _stringify_result(result)
    return {
        "mode":          f"local/{mode}",
        "user_prompt":   user_text,
        "response_text": response_text,
        "elapsed_ms":    elapsed_ms,
    }


def run_deployed(brief: dict) -> dict[str, Any]:
    """Stub. Open a WS to the deployed AgentCore Runtime, send the
    brief, collect text_delta frames, return the assembled final
    response. Needs:
      - COGNITO_ACCESS_TOKEN env var (test user, scoped to the KS)
      - VITE_AGENT_RUNTIME_ARN env var from `terraform output ui_env`
      - AWS region
    See `ui/src/lib/agent-api.ts` for the exact WS wire format
    (subprotocol auth, JSON-encoded request, SSE-shaped frames). Not
    shipped in this PR because evaluating against the deployed runtime
    needs the Cognito test user setup from ui/e2e/README.md, and
    scaffolding both in one PR mixes concerns."""
    raise NotImplementedError(
        "run_deployed is a stub — wire it up in a follow-up PR against "
        "the e2e Cognito test user."
    )


def _stringify_result(result: Any) -> str:
    """Strands' Agent returns a Response object or a plain string depending
    on how the model path finishes; both have a sensible __str__."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    try:
        return str(result)
    except Exception as e:
        print(f"runner: _stringify_result failed: {e}", file=sys.stderr)
        return ""
