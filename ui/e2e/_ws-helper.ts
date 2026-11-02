// WebSocket frame capture helpers for specs that need to assert on
// per-tool events the agent streams.
//
// The runtime emits Open-Responses events (see runtime.py). This helper
// NORMALIZES each incoming frame into the legacy shape the specs were
// written against — `{type:"tool_call"|"tool_result"|"text_delta"|"done"|"error", ...}`
// — so existing specs keep passing without per-file edits.
//
// New specs that want the raw Open-Responses envelope can read it from
// `rawEvents` instead of `events`.

import type { Page } from "@playwright/test";

export type AgentWireEvent = {
  type: string;
  tool?: string;
  parameters?: unknown;
  delta?: string;
  text?: string;
  session_id?: string;
  message?: string;
  [k: string]: unknown;
};

export type WsCapture = {
  /** Normalized events (legacy shape). */
  events: AgentWireEvent[];
  /** Raw Open-Responses events exactly as the server emitted them. */
  rawEvents: AgentWireEvent[];
  /** Resolves when a normalized event matching the predicate is received. */
  waitFor(pred: (ev: AgentWireEvent) => boolean, timeoutMs?: number): Promise<AgentWireEvent>;
};

/** Convert one Open-Responses event into zero or more legacy events. */
function normalize(raw: AgentWireEvent): AgentWireEvent[] {
  const t = raw.type;
  // Non-response.* frames (shouldn't happen with the new runtime, but
  // forward verbatim just in case the server emits a legacy frame).
  if (!t.startsWith("response.")) return [raw];

  if (t === "response.output_item.added") {
    const item = raw.item as { type?: string; name?: string; arguments?: string } | undefined;
    if (item?.type === "function_call" && item.name) {
      let parameters: unknown = undefined;
      if (typeof item.arguments === "string") {
        try { parameters = JSON.parse(item.arguments); } catch { parameters = item.arguments; }
      }
      return [{ type: "tool_call", tool: item.name, parameters }];
    }
    return [];
  }

  if (t === "response.output_item.done") {
    const item = raw.item as { type?: string; name?: string; output?: string; custom_type?: string; data?: unknown } | undefined;
    if (item?.type === "function_call" && item.name) {
      return [{ type: "tool_result", tool: item.name, text: item.output ?? "" }];
    }
    if (item?.type === "custom" && item.custom_type === "edl.plan") {
      // Specs don't currently assert on plan items, but surface it for any
      // that want to in future.
      return [{ type: "plan_item", data: item.data }];
    }
    return [];
  }

  if (t === "response.output_text.delta") {
    return [{ type: "text_delta", delta: String(raw.delta ?? "") }];
  }

  if (t === "response.completed") {
    return [{ type: "done" }];
  }

  if (t === "response.failed") {
    const err = (raw.response as { error?: { message?: string } } | undefined)?.error;
    return [{ type: "error", message: err?.message ?? "unknown error" }];
  }

  // response.created, response.output_text.done, response.keepalive — nothing
  // the legacy spec surface cares about.
  return [];
}

export function captureAgentWs(page: Page): WsCapture {
  const events: AgentWireEvent[] = [];
  const rawEvents: AgentWireEvent[] = [];
  const waiters: {
    pred: (e: AgentWireEvent) => boolean;
    resolve: (e: AgentWireEvent) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }[] = [];

  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        let raw: AgentWireEvent;
        try { raw = JSON.parse(line) as AgentWireEvent; } catch { continue; }
        rawEvents.push(raw);
        for (const ev of normalize(raw)) {
          events.push(ev);
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (w.pred(ev)) {
              clearTimeout(w.timer);
              waiters.splice(i, 1);
              w.resolve(ev);
            }
          }
        }
      }
    });
  });

  return {
    events,
    rawEvents,
    waitFor(pred, timeoutMs = 60_000) {
      const existing = events.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise<AgentWireEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`WS waitFor timed out after ${timeoutMs}ms. Seen types: ${events.map((e) => e.type).join(", ")}`));
        }, timeoutMs);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
  };
}
