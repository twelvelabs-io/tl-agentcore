// Talk to the deployed AgentCore Runtime over WebSocket. Streams events as
// they arrive; no integration-timeout ceiling.

import { getAccessToken } from "./auth";

export type AgentEvent =
  | { type: "session"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; tool: string; api?: string; parameters?: unknown; request_body?: unknown }
  | { type: "tool_result"; text?: string }
  | { type: "rationale"; text: string }
  | { type: "return_control"; payload: unknown }
  | { type: "result"; text: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  | { type: "done" }
  | { type: "heartbeat"; t?: number }
  | { type: "error"; message: string };

export type AgentTurnInput = {
  knowledge_store_id: string;
  prompt: string;
  session_id?: string;
};

const WS_URL = (import.meta.env.VITE_AGENT_WS_URL || "").replace(/\/$/, "");
const PWD    = import.meta.env.VITE_DEMO_PASSWORD || "";

export const agentEnabled = () => Boolean(WS_URL);

/** Stream a turn over WebSocket. Yields events until the agent emits `done` or `error`. */
export async function* streamAgentTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
  if (!WS_URL) throw new Error("VITE_AGENT_WS_URL not set");

  const token = await getAccessToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  else if (PWD) params.set("password", PWD);
  const ws = new WebSocket(`${WS_URL}?${params.toString()}`);

  const queue: AgentEvent[] = [];
  let resolveNext: ((v: AgentEvent | null) => void) | null = null;
  let done = false;
  let err: Error | null = null;

  ws.onmessage = (ev) => {
    const lines = String(ev.data).split("\n").map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as AgentEvent;
        if (resolveNext) { const r = resolveNext; resolveNext = null; r(obj); }
        else queue.push(obj);
      } catch { /* skip malformed */ }
    }
  };
  ws.onerror = () => { err = new Error("WebSocket error"); if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); } };
  ws.onclose = () => { done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); } };

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    setTimeout(() => rej(new Error("WS connect timeout")), 10_000);
  });

  // Wire format: route the chat lambda through InvokeAgentRuntime, forwarding
  // the user's Cognito access token so the Strands agent (in the Runtime
  // container) can call the MCP Gateway as that user — end-to-end real auth.
  ws.send(JSON.stringify({
    mode: "agentcore",
    knowledge_store_id: input.knowledge_store_id,
    prompt: input.prompt,
    session_id: input.session_id,
    access_token: token || undefined,
  }));

  try {
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (done) break;
      const next = await new Promise<AgentEvent | null>((r) => { resolveNext = r; });
      if (err) throw err;
      if (next === null) break;
      yield next;
      if (next.type === "done" || next.type === "error") break;
    }
  } finally {
    try { ws.close(); } catch {}
  }
}

