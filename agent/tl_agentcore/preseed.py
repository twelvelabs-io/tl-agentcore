"""Synthetic tool-call injection (wave-2 PR #5 of Jockey parity).

Problem: every turn against a knowledge store opens with the same two
near-reflex tool calls — `get_kb_overview` and `list_kb_assets` — before
the model has anything novel to decide. That costs two round-trips of
model latency per turn (~400-800 ms each) just to see state the runtime
already knows how to fetch itself.

Solution: before `agent.stream_async` runs, pre-execute those two tools
in parallel against the current KS and stitch the results into
`agent.messages` as a 4-message synthetic turn:

  [0] user:      "<preamble marker>"
  [1] assistant: text + toolUse(get_kb_overview) + toolUse(list_kb_assets)
  [2] user:      toolResult(overview) + toolResult(assets)
  [3] assistant: "Context loaded. Ready for the user's question."

The model then receives the real user prompt as message [4] with the
preamble already in context. Its first move can be the actual answer
instead of another `list_kb_assets`.

Both preseed tool calls get a `record_tool_call` metering row so the
usage_events ledger stays comparable with turns that call these tools
through the normal hook path.

Opt-in via `PRESEED_TOOLS_ENABLED=1` env var. Default off — flip the
flag after confirming the trace shows the tool calls were actually
redundant on the targeted turns.

Public:
  enabled() -> bool
  async maybe_preseed(agent, *, knowledge_store_id, response_id, user_id)
      -> {"used": bool, "activity": str | None}
      Mutates agent.messages in place on success. Returns a short status
      dict for the caller to emit as an activity frame.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any

from .metering import record_tool_call

_ENABLED_ENV = "PRESEED_TOOLS_ENABLED"

# Keep the preseed `list_kb_assets` cheap on prompt bytes — the full
# asset profile is already in DDB, so the model can fetch more via a
# plain tool call if it needs them.
_PRESEED_ASSETS_LIMIT = int(os.environ.get("PRESEED_ASSETS_LIMIT", "30"))


def enabled() -> bool:
    return os.environ.get(_ENABLED_ENV, "0") == "1"


async def maybe_preseed(
    agent: Any,
    *,
    knowledge_store_id: str | None,
    response_id: str,
    user_id: str | None,
) -> dict[str, Any]:
    """Fetch the preamble tools and splice them into agent.messages.

    Returns {"used": True, "activity": "preseed: ..."} on success,
    {"used": False, "activity": None} when the feature is off, no KS is
    set, or either tool failed. Never raises — a preseed problem must
    not break the user's turn."""
    if not enabled() or not knowledge_store_id:
        return {"used": False, "activity": None}

    from . import agent as _a

    # Fetch both tools in parallel. asyncio.to_thread keeps the loop
    # unblocked during DDB calls (both tools are sync and may take 10-20 ms).
    overview_t0 = time.perf_counter()
    assets_t0 = overview_t0
    try:
        overview, assets = await asyncio.gather(
            asyncio.to_thread(_a.get_kb_overview, knowledge_store_id),
            asyncio.to_thread(
                _a.list_kb_assets,
                knowledge_store_id,
                limit=_PRESEED_ASSETS_LIMIT,
            ),
            return_exceptions=True,
        )
    except Exception as e:
        # asyncio.gather with return_exceptions=True shouldn't raise, but
        # belt-and-suspenders: a scheduling issue still can't break the turn.
        print(f"preseed: gather failed: {e}")
        return {"used": False, "activity": None}
    overview_ms = int((time.perf_counter() - overview_t0) * 1000)
    assets_ms = int((time.perf_counter() - assets_t0) * 1000)

    if isinstance(overview, Exception) or isinstance(assets, Exception):
        reasons = []
        if isinstance(overview, Exception):
            reasons.append(f"get_kb_overview: {overview}")
        if isinstance(assets, Exception):
            reasons.append(f"list_kb_assets: {assets}")
        print(f"preseed: skipped ({'; '.join(reasons)})")
        return {"used": False, "activity": None}

    overview_tuid = f"preseed_overview_{uuid.uuid4().hex[:8]}"
    assets_tuid = f"preseed_assets_{uuid.uuid4().hex[:8]}"

    # Metering rows mirror what WireEventCollector would have written if
    # these had come through the normal hook path. Keeps the usage_events
    # ledger apples-to-apples across preseeded vs. non-preseeded turns.
    record_tool_call(
        user_id=user_id,
        tool_name="get_kb_overview",
        duration_ms=overview_ms,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
    )
    record_tool_call(
        user_id=user_id,
        tool_name="list_kb_assets",
        duration_ms=assets_ms,
        response_id=response_id,
        knowledge_store_id=knowledge_store_id,
    )

    # Bedrock Converse requires alternating user/assistant starting with
    # user. The marker user turn is semantically neutral so the model
    # doesn't confuse it with the real request on the next turn.
    preseed_messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": [{"text": "Preparing session context."}],
        },
        {
            "role": "assistant",
            "content": [
                {"text": "Loading KB overview and asset catalog for this knowledge store."},
                {
                    "toolUse": {
                        "toolUseId": overview_tuid,
                        "name": "get_kb_overview",
                        "input": {"knowledge_store_id": knowledge_store_id},
                    }
                },
                {
                    "toolUse": {
                        "toolUseId": assets_tuid,
                        "name": "list_kb_assets",
                        "input": {
                            "knowledge_store_id": knowledge_store_id,
                            "limit": _PRESEED_ASSETS_LIMIT,
                        },
                    }
                },
            ],
        },
        {
            "role": "user",
            "content": [
                _tool_result_block(overview_tuid, overview),
                _tool_result_block(assets_tuid, assets),
            ],
        },
        {
            "role": "assistant",
            "content": [{"text": "Context loaded. Ready for the user's question."}],
        },
    ]

    # Prepend to whatever history the agent already carries. In practice
    # a fresh build_agent returns an empty messages list, but a
    # resume-from-session path (future) could seed its own history that
    # we want to preserve.
    existing = list(getattr(agent, "messages", None) or [])
    try:
        agent.messages = preseed_messages + existing
    except Exception as e:
        print(f"preseed: assigning agent.messages failed: {e}")
        return {"used": False, "activity": None}

    asset_count = len(assets) if isinstance(assets, list) else 0
    return {
        "used": True,
        "activity": (
            f"preseed: get_kb_overview + list_kb_assets "
            f"(assets={asset_count}, {overview_ms + assets_ms} ms)"
        ),
    }


def _tool_result_block(tool_use_id: str, result: Any) -> dict[str, Any]:
    """Bedrock Converse toolResult content block. The tool output goes
    inside a nested `{"text": "..."}` block since all our tools return
    JSON-serializable primitives / dicts / lists."""
    try:
        text = json.dumps(result, default=str)
    except Exception as e:
        text = f'{{"error": "preseed serialize failed: {e}"}}'
    return {
        "toolResult": {
            "toolUseId": tool_use_id,
            "content": [{"text": text}],
            "status": "success",
        }
    }
