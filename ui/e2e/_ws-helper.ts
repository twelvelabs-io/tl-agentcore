// WebSocket frame capture helpers for specs that need to assert on
// per-tool events streamed from the chat lambda (tool_call,
// tool_result). The lambda emits one newline-separated JSON object
// per WS frame; we parse each frame and append the typed events into
// an array the spec can poll or assert against.

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
  events: AgentWireEvent[];
  /** Resolves when an event matching the predicate is received. */
  waitFor(pred: (ev: AgentWireEvent) => boolean, timeoutMs?: number): Promise<AgentWireEvent>;
};

export function captureAgentWs(page: Page): WsCapture {
  const events: AgentWireEvent[] = [];
  const waiters: { pred: (e: AgentWireEvent) => boolean; resolve: (e: AgentWireEvent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf-8");
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as AgentWireEvent;
          events.push(ev);
          // Settle any waiter whose predicate now matches.
          for (let i = waiters.length - 1; i >= 0; i--) {
            const w = waiters[i];
            if (w.pred(ev)) {
              clearTimeout(w.timer);
              waiters.splice(i, 1);
              w.resolve(ev);
            }
          }
        } catch { /* skip malformed frames */ }
      }
    });
  });

  return {
    events,
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
