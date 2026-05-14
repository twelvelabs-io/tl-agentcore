// Talk to the deployed Bedrock-agent over WebSocket. Streams events as they
// arrive; no integration-timeout ceiling.

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
  mode?: "bedrock" | "agentcore";
};

export type JockeyDirectInput = {
  knowledge_store_id: string;
  prompt: string;
  instructions?: string;
  session_id?: string;
  text_format?: object;
  include?: string[];
  model?: string;
};

export type JockeyDirectResult = {
  text: string;
  session_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
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

  // Send the turn. Mode "agentcore" routes the chat lambda through
  // InvokeAgentRuntime, and forwards the user's Cognito access token so the
  // Strands agent (in the Runtime container) can call the MCP Gateway as
  // that user — end-to-end real auth.
  const wireMessage =
    input.mode === "agentcore"
      ? { mode: "agentcore", knowledge_store_id: input.knowledge_store_id, prompt: input.prompt, session_id: input.session_id, access_token: token || undefined }
      : { knowledge_store_id: input.knowledge_store_id, prompt: input.prompt, session_id: input.session_id };
  ws.send(JSON.stringify(wireMessage));

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

/** Direct Jockey passthrough over WebSocket. Used by Reel + Lens — these calls
 * regularly take >30s for structured-output, which the HTTP API path can't
 * accommodate. The WS path bypasses the integration timeout. */
export async function callJockeyDirect(input: JockeyDirectInput): Promise<JockeyDirectResult> {
  if (!WS_URL) throw new Error("VITE_AGENT_WS_URL not set");

  const token = await getAccessToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  else if (PWD) params.set("password", PWD);
  const ws = new WebSocket(`${WS_URL}?${params.toString()}`);

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    setTimeout(() => rej(new Error("WS connect timeout")), 10_000);
  });

  return new Promise<JockeyDirectResult>((resolve, reject) => {
    let resolved = false;
    let collected: JockeyDirectResult | null = null;

    ws.onmessage = (ev) => {
      const lines = String(ev.data).split("\n").map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line) as AgentEvent;
          if (obj.type === "result") {
            collected = { text: obj.text, session_id: obj.session_id, usage: obj.usage };
          } else if (obj.type === "error") {
            if (!resolved) { resolved = true; reject(new Error(obj.message)); ws.close(); }
          } else if (obj.type === "done") {
            if (!resolved) {
              resolved = true;
              if (collected) resolve(collected);
              else reject(new Error("done without result"));
              ws.close();
            }
          }
        } catch { /* skip malformed */ }
      }
    };
    ws.onerror = () => { if (!resolved) { resolved = true; reject(new Error("WebSocket error")); } };
    ws.onclose = () => { if (!resolved) { resolved = true; reject(new Error("WS closed before result")); } };

    ws.send(JSON.stringify({ mode: "jockey", ...input }));
  });
}
