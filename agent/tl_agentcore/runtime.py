"""AgentCore Runtime entrypoint — exposes BOTH the legacy SSE endpoint AND
the native WebSocket endpoint that lets the browser connect directly.

  POST /invocations  — JSON body in, SSE stream out. Kept for backward
                       compatibility with the chat-lambda → SigV4 path.
  WS   /ws           — JSON message in, JSON messages stream out. Native
                       browser path; the chat lambda becomes optional.
  GET  /ping         — health check (provided by BedrockAgentCoreApp).

Payload (both endpoints):
  {
    "knowledge_store_id": "ks_...",
    "prompt": "...",
    "access_token": "<cognito jwt>"   # optional — when present, the agent
                                      # authenticates to the MCP Gateway with
                                      # this token. Absent → in-process tools.
  }

Wire format — same JSON event shapes flow over BOTH endpoints. SSE wraps each
event in `data: {...}\\n\\n`; WS sends each event as a discrete text frame.

  {"type": "tool_call",   "tool": "vector_search", "parameters": {...}}
  {"type": "tool_result", "tool": "vector_search", "text": "<truncated>"}
  {"type": "text_delta",  "delta": "..."}
  {"type": "result",      "text": "<full final answer>", "tool_path": "in-process"}
  {"type": "done"}                                 # WS-only terminator
  {"type": "error",       "message": "...", "trace": "..."}
"""

from __future__ import annotations

import asyncio
import json
import os
import traceback
from typing import Any, AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands.hooks import HookProvider, HookRegistry
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent

from .agent import build_agent
from .duration_enforcer import enforce_duration_target

app = BedrockAgentCoreApp()


class WireEventCollector(HookProvider):
    """Hook provider that captures tool start + end events into an asyncio
    queue. Drained between Strands stream-async yields so each tool call
    shows up in the UI right when it fires."""

    def __init__(self, queue: asyncio.Queue):
        self.queue = queue

    def register_hooks(self, registry: HookRegistry, **_kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._on_before)
        registry.add_callback(AfterToolCallEvent, self._on_after)

    def _on_before(self, event: BeforeToolCallEvent) -> None:
        tool_use = event.tool_use or {}
        self.queue.put_nowait({
            "type": "tool_call",
            "tool": tool_use.get("name", "<unknown>"),
            "parameters": tool_use.get("input") or {},
        })

    def _on_after(self, event: AfterToolCallEvent) -> None:
        tool_use = event.tool_use or {}
        text = _summarize_tool_result(event.result)
        self.queue.put_nowait({
            "type": "tool_result",
            "tool": tool_use.get("name", "<unknown>"),
            "text": text[:600],
        })


def _summarize_tool_result(result: Any) -> str:
    if isinstance(result, Exception):
        return f"error: {result}"
    if not isinstance(result, dict):
        return str(result)
    content = result.get("content")
    if not isinstance(content, list):
        return json.dumps(result)[:600]
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if "text" in block:
            parts.append(str(block["text"]))
        elif "json" in block:
            parts.append(json.dumps(block["json"]))
    return " | ".join(parts) if parts else json.dumps(result)[:600]


# ─── Shared event-stream generator ──────────────────────────────────────────
# One source of truth for the per-turn event sequence. Consumed by both the
# SSE entrypoint (yields to the AgentCore framework's SSE encoder) and the
# WS handler (sends each event as a discrete JSON frame).
async def _stream_events(payload: dict) -> AsyncIterator[dict]:
    ks = payload.get("knowledge_store_id")
    prompt = payload.get("prompt") or ""
    access_token = payload.get("access_token")
    if not prompt:
        yield {"type": "error", "message": "missing prompt"}
        return

    user_text = prompt if not ks else f"[ks: {ks}]\n{prompt}"

    queue: asyncio.Queue = asyncio.Queue()
    try:
        agent, mode = build_agent(access_token=access_token)
        agent.hooks.add_hook(WireEventCollector(queue))
    except Exception as e:
        yield {
            "type": "error",
            "message": f"agent build failed: {e}",
            "trace": traceback.format_exc(),
        }
        return

    final_text = ""
    try:
        async for event in agent.stream_async(user_text):
            # Drain tool events the hooks queued during this step first —
            # keeps UI ordering close to wall-clock order.
            while not queue.empty():
                yield queue.get_nowait()

            if not isinstance(event, dict):
                continue

            text_chunk = event.get("data")
            if isinstance(text_chunk, str) and text_chunk:
                final_text += text_chunk
                yield {"type": "text_delta", "delta": text_chunk}
                continue

            result = event.get("result")
            if result is not None:
                final_text = str(result) or final_text

        while not queue.empty():
            yield queue.get_nowait()

    except Exception as e:
        yield {
            "type": "error",
            "message": f"agent run failed: {e}",
            "trace": traceback.format_exc(),
            "tool_path": mode,
        }
        return

    # Deterministic guardrail: if the brief stated a duration target and the
    # emitted plan missed the band, post-process the plan (extend or trim
    # primary clip end times within the cut-type cap) and stream both the
    # note and the corrected text so the UI's running buffer ends with the
    # rewritten <plan>. The model's prose stays as-is; the runtime appends a
    # one-line annotation explaining what changed.
    try:
        corrected_text, note = enforce_duration_target(final_text, prompt)
    except Exception as e:
        # Don't crash the turn on a post-processor bug — log + pass through.
        print(f"runtime: duration_enforcer failed: {e}")
        corrected_text, note = final_text, None

    if note:
        # ORDER MATTERS:
        # 1. `plan_corrected` carries the full corrected text — UI replaces
        #    its accumulator wholesale so extractPlan() picks up the rewritten
        #    <plan> JSON instead of the model's original.
        # 2. Then a text_delta with the one-line note, so the prose ends with
        #    a clear annotation of what the runtime did.
        yield {"type": "plan_corrected", "text": corrected_text}
        yield {"type": "text_delta", "delta": f"\n\n{note}"}
        final_text = corrected_text + f"\n\n{note}"

    yield {"type": "result", "text": final_text, "tool_path": mode}


# ─── SSE entrypoint (legacy: chat λ → InvokeAgentRuntime → SSE) ─────────────
@app.entrypoint
async def invoke(payload: dict, _context: Any = None) -> AsyncIterator[dict]:
    """One agent turn over the legacy POST /invocations path. Each yielded
    dict becomes a `data: {...}\\n\\n` SSE frame courtesy of BedrockAgentCoreApp."""
    async for event in _stream_events(payload):
        yield event


# ─── WebSocket entrypoint (native: browser → wss://...runtimes/<arn>/ws) ────
@app.websocket
async def ws_handler(websocket, _context: Any) -> None:
    """One agent turn per WS connection. Read the first JSON frame as the
    payload, stream events back as JSON frames, send a terminal {"type":"done"}
    so the client can re-enable input, then close.

    AgentCore Runtime invokes this with the WS already authenticated (Cognito
    JWT via the runtime's JWT authorizer config). We don't re-verify here.
    """
    await websocket.accept()
    try:
        raw = await websocket.receive_text()
        try:
            payload = json.loads(raw)
        except Exception:
            await websocket.send_text(json.dumps({"type": "error", "message": "invalid JSON body"}))
            await websocket.close(code=1003)  # 1003 = unsupported data
            return

        async for event in _stream_events(payload):
            await websocket.send_text(json.dumps(event))

        # Terminal frame so the UI knows the turn ended even if no `result`
        # fired (e.g. error path). UI re-enables input on done.
        await websocket.send_text(json.dumps({"type": "done"}))

    except Exception as e:
        try:
            await websocket.send_text(json.dumps({
                "type": "error",
                "message": f"ws handler failed: {e}",
                "trace": traceback.format_exc(),
            }))
        except Exception:
            pass
        try:
            await websocket.close(code=1011)  # 1011 = server error
        except Exception:
            pass
        return

    # Normal closure after one turn. The browser opens a fresh WS per turn,
    # matching the chat-lambda behavior we're replacing. Session continuity
    # (same runtime session across turns) comes from the session_id query
    # param the browser passes on connect.
    await websocket.close(code=1000)


if __name__ == "__main__":
    # The AgentCore Runtime container only listens for traffic from
    # bedrock-agentcore's internal network — it's never publicly reachable.
    # The 0.0.0.0 bind is the SDK-required contract. Semgrep flags
    # top-level app.run() as ignored by flask, but bedrock-agentcore's
    # runtime harness invokes this module directly via
    # `python -m tl_agentcore.runtime`, so the module-level app.run IS
    # what starts the server.
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosemgrep
