"""AgentCore Runtime entrypoint — Open-Responses event taxonomy (v2).

Exposes BOTH the SSE endpoint AND the native WebSocket endpoint. Both emit
the SAME event stream, modeled on OpenAI's Open-Responses API.

  POST /invocations  — JSON body in, SSE stream out (`data: {...}\\n\\n`).
  WS   /ws           — JSON message in, JSON messages stream out.
  GET  /ping         — health check (provided by BedrockAgentCoreApp).

Payload (both endpoints):
  {
    "knowledge_store_id": "ks_...",
    "prompt": "...",
    "access_token": "<cognito jwt>"   # optional — forwarded to MCP Gateway
                                      # when the agent is in MCP mode.
  }

Wire format — every event carries a monotonic `sequence_number` starting at
0 for the connection. Event taxonomy:

  {"type": "response.created",            "sequence_number": 0,  "response": {...}}
  {"type": "response.output_item.added",  "sequence_number": 1,  "output_index": 0, "item": {...}}
  {"type": "response.output_text.delta",  "sequence_number": 2,  "item_id": "...", "delta": "..."}
  {"type": "response.output_text.done",   "sequence_number": N,  "item_id": "...", "text": "..."}
  {"type": "response.output_item.done",   "sequence_number": N,  "output_index": 0, "item": {...}}
  {"type": "response.keepalive",          "sequence_number": N}
  {"type": "response.activity",           "sequence_number": N,  "tool_use_id": "...", "text": "..."}
  {"type": "response.completed",          "sequence_number": N,  "response": {...}}
  {"type": "response.failed",             "sequence_number": N,  "response": {...}}

Output-item shapes we emit:
  - `message` (assistant prose) — content: [{"type":"output_text","text":"..."}]
  - `function_call` (one per tool call) — {id, name, arguments:string, output?,
     status:"completed"|"failed", error_code?}. error_code comes from
     error_taxonomy.classify when the tool returned {"error":...} or raised.
  - `custom` with `custom_type:"edl.plan"` — carries the parsed Edit Decision
    List JSON in `data`. The duration_enforcer rewrite emits a SECOND
    `output_item.done` with the same `item.id` — supersedes-in-place.

Error shape on `response.failed`: {"message":"...", "code":"<bucket>",
"trace":"..."?}. `code` is a stable slug from error_taxonomy — see that
module for the enum. UIs should map on `code`, not regex the message.

Keepalives (`response.keepalive`) fire on every 20 s of upstream silence to
keep ALB/CloudFront from idle-killing a WS during a slow `pegasus_analyze`.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import traceback
import uuid
from typing import Any, AsyncIterator, Optional

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
from strands.hooks import HookProvider, HookRegistry
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent

from .agent import (
    MODEL_ID,
    _current_user_id,
    build_agent,
    persist_session_turn,
    set_selections_from_payload,
    set_user_id_from_token,
)
from .activity_narrator import narrate as narrate_activity
from .aliases import expand_text as expand_id_aliases, reset_turn_aliases
from .duration_enforcer import _extract_plan_block, enforce_duration_target
from .error_taxonomy import classify as classify_error
from .metering import (
    record_model_invocation,
    record_pipeline_fallback,
    record_tool_call,
)
from .pipelines import RewooFallback, run_rewoo, select_pipeline
from .preseed import maybe_preseed
from .scoring import maybe_judge_turn

app = BedrockAgentCoreApp()

# ALB default idle is 60 s. 20 s gives us 2 keepalives before an idle cut
# — plenty of headroom even if one keepalive is lost in-flight.
KEEPALIVE_INTERVAL_S = 20.0


# ─── Hook that captures Strands tool start/end into an asyncio queue ────────
class WireEventCollector(HookProvider):
    """Captures tool start + end events for the main loop to drain. Emits
    SEMANTIC `__kind__` markers; the envelope wrapper converts them to
    Open-Responses events."""

    def __init__(
        self,
        queue: asyncio.Queue,
        *,
        response_id: str,
        knowledge_store_id: str | None,
    ):
        self.queue = queue
        self.response_id = response_id
        self.knowledge_store_id = knowledge_store_id
        # tool_use_id -> perf_counter at start. Lets _on_after derive the
        # tool's wall-clock duration for the metering ledger.
        self._starts: dict[str, float] = {}

    def register_hooks(self, registry: HookRegistry, **_kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._on_before)
        registry.add_callback(AfterToolCallEvent, self._on_after)

    def _on_before(self, event: BeforeToolCallEvent) -> None:
        tool_use = event.tool_use or {}
        name = tool_use.get("name", "<unknown>")
        args = tool_use.get("input") or {}
        tool_use_id = tool_use.get("toolUseId") or f"call_{uuid.uuid4().hex[:12]}"
        self._starts[tool_use_id] = time.perf_counter()
        # Human-readable "doing X now" sentence shipped alongside the raw
        # tool_begin event. The UI can render this as a status pip while
        # hiding the raw function_call JSON — see activity_narrator.
        self.queue.put_nowait({
            "__kind__": "activity",
            "tool_use_id": tool_use_id,
            "text": narrate_activity(name, args),
        })
        self.queue.put_nowait({
            "__kind__": "tool_begin",
            "tool_use_id": tool_use_id,
            "name": name,
            "arguments": args,
        })

    def _on_after(self, event: AfterToolCallEvent) -> None:
        tool_use = event.tool_use or {}
        tuid = tool_use.get("toolUseId") or ""
        name = tool_use.get("name", "<unknown>")
        t0 = self._starts.pop(tuid, None)
        duration_ms = int((time.perf_counter() - t0) * 1000) if t0 else 0
        summary = _summarize_tool_result(event.result)
        code = _tool_error_code(event.result, summary)

        # Fire-and-forget metering row. The hook runs synchronously
        # inside strands' loop, but record_tool_call is wrapped in its
        # own try/except so a DDB hiccup can't propagate up.
        record_tool_call(
            user_id=_current_user_id(),
            tool_name=name,
            duration_ms=duration_ms,
            response_id=self.response_id,
            knowledge_store_id=self.knowledge_store_id,
        )

        payload = {
            "__kind__": "tool_end",
            "tool_use_id": tuid,
            "name": name,
            "output": summary,
        }
        if code:
            payload["error_code"] = code
        self.queue.put_nowait(payload)


def _tool_error_code(result: Any, summary: str) -> str | None:
    """Classify a tool result as an error bucket, or None if the tool
    succeeded. Covers three shapes the agent's tools actually return:
    (a) a raised exception caught by Strands, (b) a dict with
    `status == 'error'`, and (c) a dict with an `error` key (our
    hand-rolled `return {"error": "..."}` branches)."""
    if isinstance(result, BaseException):
        return classify_error(str(result), exc=result)
    if isinstance(result, dict):
        if result.get("status") == "error":
            return classify_error(summary) or classify_error("tool error")
        if "error" in result and result["error"]:
            return classify_error(str(result["error"]))
    return None


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


# ─── Semantic-event generator ───────────────────────────────────────────────
# Yields raw `__kind__`-tagged dicts describing what happened. The envelope
# wrapper below assigns sequence numbers and maps them to `response.*` events.
async def _semantic_stream(payload: dict) -> AsyncIterator[dict]:
    ks = payload.get("knowledge_store_id")
    prompt = payload.get("prompt") or ""
    access_token = payload.get("access_token")
    response_id = f"resp_{uuid.uuid4().hex[:12]}"

    if not prompt:
        yield {"__kind__": "failed", "response_id": response_id,
               "error": {"message": "missing prompt",
                         "code": classify_error("missing prompt")}}
        return

    # PR #8: pull the per-turn working set and stash it on the agent's
    # selections ContextVar. Content-domain tools default their asset_id /
    # bounds / knowledge_store_id args from selections[0] when the agent
    # didn't pass them explicitly. We also prepend a one-line [selections:
    # ...] marker to the user text so the agent SEES the working set and can
    # reason about it ("that clip", "the second one").
    selections = set_selections_from_payload(payload.get("selections"))

    user_text = prompt if not ks else f"[ks: {ks}]\n{prompt}"
    if selections:
        parts = []
        for s in selections[:8]:
            bits = [s["asset_id"]]
            if s.get("start_sec") is not None and s.get("end_sec") is not None:
                bits.append(f"{s['start_sec']:.1f}-{s['end_sec']:.1f}s")
            parts.append("/".join(bits))
        more = "" if len(selections) <= 8 else f" (+{len(selections)-8} more)"
        user_text = f"[selections: {', '.join(parts)}{more}]\n{user_text}"

    yield {"__kind__": "created", "response_id": response_id}

    # Seed the per-turn user_id ContextVar so manage_memory /
    # save_tref_to_memory can namespace writes to this Cognito sub. Decoding
    # here is safe — the AgentCore JWT authorizer already verified the token
    # before the request reached us.
    set_user_id_from_token(access_token)

    # Wave-2 PR #4: install a fresh per-turn alias map so asset_id
    # handles (`@id_N`) allocated during one tool call stay bound for
    # the rest of this turn and get wiped before the next.
    reset_turn_aliases()

    # Wave-2 PR #11: pipeline selection. ReWOO handles info-type turns
    # with a fixed planner+executor+solver round-trip; ReAct is the
    # default for structural / ambiguous turns and the fallback target
    # when ReWOO's executor hits a problem it can't recover from.
    pipeline, pipeline_reason = select_pipeline(payload)
    text_item_id = f"msg_{uuid.uuid4().hex[:12]}"
    text_started = False
    final_text = ""
    mode = pipeline  # observability — overwritten by the ReAct branch

    yield {
        "__kind__": "activity",
        "tool_use_id": response_id,
        "text": f"pipeline: {pipeline} ({pipeline_reason})",
    }

    if pipeline == "rewoo":
        try:
            async for ev in run_rewoo(
                prompt=prompt,
                user_text=user_text,
                knowledge_store_id=ks,
                response_id=response_id,
                selections=selections,
                access_token=access_token,
            ):
                kind = ev.get("__kind__")
                if kind == "text_begin":
                    text_started = True
                elif kind == "text_delta":
                    final_text += ev.get("delta", "")
                elif kind == "text_done":
                    final_text = ev.get("text", final_text)
                yield ev
        except RewooFallback as e:
            yield {
                "__kind__": "activity",
                "tool_use_id": response_id,
                "text": f"rewoo fallback → react ({e})",
            }
            # Structured telemetry row so dashboards can group-by
            # reason_class + stage. The free-text activity frame above
            # stays for the UI trace strip, but the raw message isn't
            # queryable; this row is.
            record_pipeline_fallback(
                user_id=_current_user_id(),
                response_id=response_id,
                knowledge_store_id=ks,
                from_pipeline="rewoo",
                to_pipeline="react",
                reason_message=str(e),
            )
            text_started = False
            final_text = ""
            pipeline = "react"
            text_item_id = f"msg_{uuid.uuid4().hex[:12]}"

    if pipeline == "react":
        queue: asyncio.Queue = asyncio.Queue()
        try:
            agent, mode = build_agent(access_token=access_token)
            agent.hooks.add_hook(WireEventCollector(
                queue,
                response_id=response_id,
                knowledge_store_id=ks,
            ))
        except Exception as e:
            yield {"__kind__": "failed", "response_id": response_id,
                   "error": {"message": f"agent build failed: {e}",
                             "code": classify_error(f"agent build failed: {e}", exc=e),
                             "trace": traceback.format_exc()}}
            return

        # Wave-2 PR #5: synthetic tool-call injection. Pre-execute
        # get_kb_overview + list_kb_assets for the current KS and splice
        # them into agent.messages as a 4-message synthetic turn so the
        # model's first move can skip two near-reflex tool calls. No-op
        # when no KS is set on the payload. Fails soft — a preseed error
        # never breaks the user's turn.
        try:
            preseed_status = await maybe_preseed(
                agent,
                knowledge_store_id=ks,
                response_id=response_id,
                user_id=_current_user_id(),
            )
            if preseed_status.get("activity"):
                yield {
                    "__kind__": "activity",
                    "tool_use_id": response_id,
                    "text": preseed_status["activity"],
                }
        except Exception as e:
            print(f"runtime: preseed dispatch failed: {e}")

        try:
            async for event in agent.stream_async(user_text):
                while not queue.empty():
                    yield queue.get_nowait()

                if not isinstance(event, dict):
                    continue

                chunk = event.get("data")
                if isinstance(chunk, str) and chunk:
                    if not text_started:
                        text_started = True
                        yield {"__kind__": "text_begin", "item_id": text_item_id}
                    final_text += chunk
                    yield {"__kind__": "text_delta",
                           "item_id": text_item_id, "delta": chunk}
                    continue

                # One Strands event per completed model cycle carries a
                # `stop` tuple: (stop_reason, message, usage, metrics). We
                # mint one metering row per cycle so a multi-turn ReAct
                # trace shows up as N `model_invoke` rows, not one. Any
                # metering miss logs and continues.
                stop_tuple = event.get("stop")
                if isinstance(stop_tuple, tuple) and len(stop_tuple) >= 4:
                    try:
                        _, _msg, usage, metrics = stop_tuple
                        record_model_invocation(
                            user_id=_current_user_id(),
                            model_id=MODEL_ID,
                            input_tokens=int((usage or {}).get("inputTokens", 0)),
                            output_tokens=int((usage or {}).get("outputTokens", 0)),
                            latency_ms=int((metrics or {}).get("latencyMs", 0)),
                            response_id=response_id,
                            knowledge_store_id=ks,
                        )
                    except Exception as e:
                        print(f"runtime: model metering failed: {e}")

                result = event.get("result")
                if result is not None:
                    final_text = str(result) or final_text

            while not queue.empty():
                yield queue.get_nowait()
        except Exception as e:
            yield {"__kind__": "failed", "response_id": response_id,
                   "error": {"message": f"agent run failed: {e}",
                             "code": classify_error(f"agent run failed: {e}", exc=e),
                             "trace": traceback.format_exc()},
                   "tool_path": mode}
            return

    # Wave-2 PR #4: expand any `@id_N` handles the model emitted in its
    # final prose back to real 24-hex asset_ids BEFORE plan extraction.
    # The UI, duration enforcer, session persist, and generate_video all
    # need real ids inside the <plan> block. No-op when disabled.
    final_text = expand_id_aliases(final_text)

    # EDL extraction. If the model's prose included a <plan>...</plan> block
    # with parseable JSON, emit it as a `custom` output item so the UI
    # doesn't have to regex-scan the text stream.
    plan_match = _extract_plan_block(final_text)
    plan_item_id: Optional[str] = None
    if plan_match:
        _, parsed_plan, _, _ = plan_match
        plan_item_id = f"edl_{uuid.uuid4().hex[:12]}"
        yield {"__kind__": "plan_item",
               "item_id": plan_item_id, "data": parsed_plan}

    # Deterministic guardrail: if the brief stated a duration target and the
    # emitted plan missed the band, post-process and emit a corrected plan
    # item with the SAME item_id (supersedes-in-place).
    try:
        corrected_text, note = enforce_duration_target(final_text, prompt)
    except Exception as e:
        print(f"runtime: duration_enforcer failed: {e}")
        corrected_text, note = final_text, None

    if note and plan_item_id:
        new_match = _extract_plan_block(corrected_text)
        if new_match:
            _, parsed_corr, _, _ = new_match
            yield {"__kind__": "plan_corrected",
                   "item_id": plan_item_id, "data": parsed_corr, "note": note}
        final_text = corrected_text + f"\n\n{note}"

    if text_started:
        yield {"__kind__": "text_done",
               "item_id": text_item_id, "text": final_text}

    # Write-only session persistence: stash this turn's prompt, final text,
    # and extracted <plan> in the sessions table under the AgentCore session
    # id. Read-for-resume lands in the follow-up to PR #15 (previous_response_id
    # wire semantics). Fails soft; a DDB write hiccup must not break the turn.
    try:
        session_id = BedrockAgentCoreContext.get_session_id()
    except Exception:
        session_id = None
    try:
        persist_session_turn(
            session_id=session_id,
            knowledge_store_id=ks,
            prompt=prompt,
            response_text=final_text,
            tool_path=mode,
        )
    except Exception as e:
        print(f"runtime: session persistence failed: {e}")

    # Fire-and-forget online judges. Returns immediately; the judge
    # tasks run on the loop while we yield the completed event. A judge
    # failure logs but can't affect the user response.
    try:
        maybe_judge_turn(
            prompt=prompt,
            response_text=final_text,
            response_id=response_id,
            knowledge_store_id=ks,
            user_id=_current_user_id(),
        )
    except Exception as e:
        print(f"runtime: judge dispatch failed: {e}")

    yield {"__kind__": "completed",
           "response_id": response_id, "tool_path": mode}


# ─── Keepalive wrapper ──────────────────────────────────────────────────────
async def _with_keepalive(
    stream: AsyncIterator[dict],
    interval: float = KEEPALIVE_INTERVAL_S,
) -> AsyncIterator[dict]:
    """Inject `__kind__: "keepalive"` on `interval` seconds of upstream silence.
    Runs the upstream in a background task feeding an asyncio.Queue; the
    outer loop times out on queue.get and yields a keepalive marker."""
    queue: asyncio.Queue = asyncio.Queue()
    _SENTINEL = object()

    async def _pump() -> None:
        try:
            async for item in stream:
                await queue.put(item)
        except Exception as e:
            await queue.put({"__kind__": "failed",
                             "response_id": "",
                             "error": {"message": f"stream pump failed: {e}",
                                       "code": classify_error(f"stream pump failed: {e}", exc=e),
                                       "trace": traceback.format_exc()}})
        finally:
            await queue.put(_SENTINEL)

    task = asyncio.create_task(_pump())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                yield {"__kind__": "keepalive"}
                continue
            if item is _SENTINEL:
                return
            yield item
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


# ─── Envelope: semantic kinds → Open-Responses events + sequence numbers ───
async def _envelope(stream: AsyncIterator[dict]) -> AsyncIterator[dict]:
    seq = 0
    created_at = int(time.time())

    def _emit(type_: str, **payload) -> dict:
        nonlocal seq
        e = {"type": type_, "sequence_number": seq, **payload}
        seq += 1
        return e

    response_id = ""

    async for raw in stream:
        kind = raw.get("__kind__")

        if kind == "created":
            response_id = raw["response_id"]
            yield _emit("response.created", response={
                "id": response_id,
                "object": "response",
                "created_at": created_at,
                "status": "in_progress",
            })

        elif kind == "text_begin":
            yield _emit("response.output_item.added", output_index=0, item={
                "id": raw["item_id"],
                "type": "message",
                "status": "in_progress",
                "role": "assistant",
                "content": [],
            })

        elif kind == "text_delta":
            yield _emit("response.output_text.delta",
                        item_id=raw["item_id"],
                        output_index=0,
                        content_index=0,
                        delta=raw["delta"])

        elif kind == "text_done":
            yield _emit("response.output_text.done",
                        item_id=raw["item_id"],
                        output_index=0,
                        content_index=0,
                        text=raw["text"])
            yield _emit("response.output_item.done", output_index=0, item={
                "id": raw["item_id"],
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": raw["text"]}],
            })

        elif kind == "tool_begin":
            yield _emit("response.output_item.added", output_index=0, item={
                "id": raw["tool_use_id"],
                "type": "function_call",
                "status": "in_progress",
                "name": raw["name"],
                "arguments": json.dumps(raw["arguments"]),
            })

        elif kind == "tool_end":
            item: dict[str, Any] = {
                "id": raw["tool_use_id"],
                "type": "function_call",
                "status": "failed" if raw.get("error_code") else "completed",
                "name": raw["name"],
                "output": raw["output"][:600],
            }
            if raw.get("error_code"):
                item["error_code"] = raw["error_code"]
            yield _emit("response.output_item.done", output_index=0, item=item)

        elif kind == "plan_item":
            yield _emit("response.output_item.added", output_index=0, item={
                "id": raw["item_id"],
                "type": "custom",
                "custom_type": "edl.plan",
                "status": "in_progress",
            })
            yield _emit("response.output_item.done", output_index=0, item={
                "id": raw["item_id"],
                "type": "custom",
                "custom_type": "edl.plan",
                "status": "completed",
                "data": raw["data"],
            })

        elif kind == "plan_corrected":
            # Re-emit output_item.done on the SAME item id: UI replaces the
            # previously-rendered plan with the corrected one in place.
            yield _emit("response.output_item.done", output_index=0, item={
                "id": raw["item_id"],
                "type": "custom",
                "custom_type": "edl.plan",
                "status": "completed",
                "data": raw["data"],
                "correction_note": raw["note"],
            })

        elif kind == "keepalive":
            yield _emit("response.keepalive")

        elif kind == "activity":
            yield _emit("response.activity",
                        tool_use_id=raw["tool_use_id"],
                        text=raw["text"])

        elif kind == "completed":
            yield _emit("response.completed", response={
                "id": raw["response_id"],
                "object": "response",
                "status": "completed",
                "tool_path": raw.get("tool_path"),
            })

        elif kind == "failed":
            yield _emit("response.failed", response={
                "id": raw.get("response_id") or response_id,
                "object": "response",
                "status": "failed",
                "error": raw["error"],
                "tool_path": raw.get("tool_path"),
            })


# ─── Shared pipeline ────────────────────────────────────────────────────────
def _event_pipeline(payload: dict) -> AsyncIterator[dict]:
    return _envelope(_with_keepalive(_semantic_stream(payload)))


# ─── SSE entrypoint ─────────────────────────────────────────────────────────
@app.entrypoint
async def invoke(payload: dict, _context: Any = None) -> AsyncIterator[dict]:
    """One agent turn, SSE-encoded by BedrockAgentCoreApp (each yielded dict
    becomes `data: {...}\\n\\n`)."""
    async for event in _event_pipeline(payload):
        yield event


# ─── WebSocket entrypoint ───────────────────────────────────────────────────
@app.websocket
async def ws_handler(websocket, _context: Any) -> None:
    """One agent turn per WS connection. Reads the first JSON frame as
    payload, streams Open-Responses events as JSON frames, closes 1000 on
    `response.completed` or 1011 on unexpected failure.

    AgentCore Runtime verifies the Cognito JWT at the gateway via its
    customJWTAuthorizer config, so this handler doesn't re-verify.
    """
    await websocket.accept()
    try:
        raw = await websocket.receive_text()
        try:
            payload = json.loads(raw)
        except Exception:
            await websocket.send_text(json.dumps({
                "type": "response.failed",
                "sequence_number": 0,
                "response": {
                    "status": "failed",
                    "error": {"message": "invalid JSON body",
                              "code": classify_error("invalid JSON body")},
                },
            }))
            await websocket.close(code=1003)  # 1003 = unsupported data
            return

        async for event in _event_pipeline(payload):
            await websocket.send_text(json.dumps(event))

    except Exception as e:
        try:
            await websocket.send_text(json.dumps({
                "type": "response.failed",
                "sequence_number": 999,
                "response": {
                    "status": "failed",
                    "error": {
                        "message": f"ws handler failed: {e}",
                        "code": classify_error(f"ws handler failed: {e}", exc=e),
                        "trace": traceback.format_exc(),
                    },
                },
            }))
        except Exception:
            pass
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
        return

    await websocket.close(code=1000)


if __name__ == "__main__":
    # The AgentCore Runtime container only listens for traffic from
    # bedrock-agentcore's internal network — never publicly reachable.
    # The 0.0.0.0 bind is the SDK-required contract. nosemgrep because the
    # SDK harness launches this module via `python -m tl_agentcore.runtime`
    # and relies on module-level app.run to start the server.
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))  # nosemgrep
