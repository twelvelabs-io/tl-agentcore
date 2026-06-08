// Talk to the deployed AgentCore Runtime over its NATIVE WebSocket. The
// browser connects directly to wss://bedrock-agentcore.<region>.amazonaws.com
// — no chat lambda, no API Gateway, no CloudFront hop. Authentication is the
// user's Cognito access token, passed via the Sec-WebSocket-Protocol
// subprotocol trick because browsers can't set custom headers on a WS
// handshake. AgentCore Runtime is configured with a customJWTAuthorizer
// (allowed_clients = SPA client id) that verifies the token at the gateway.
//
// Wire format on the WS:
//   client → server: ONE JSON frame on connect = { knowledge_store_id, prompt, access_token? }
//   server → client: many JSON frames = { type: "tool_call"|"tool_result"|
//                    "text_delta"|"result"|"error"|"done", ... }
//
// The same JSON shapes the SSE path used before; the wrapper at the edge is
// the only thing that changed. UI consumers (AgentCore.tsx, RoughCut.tsx)
// don't need to know.

import { getAccessToken } from "./auth";

export type AgentEvent =
  | { type: "session"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; tool: string; api?: string; parameters?: unknown; request_body?: unknown }
  | { type: "tool_result"; text?: string }
  | { type: "rationale"; text: string }
  | { type: "return_control"; payload: unknown }
  | { type: "result"; text: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number }; tool_path?: string }
  // Runtime-side post-processor rewrote the model's <plan> block to satisfy
  // the duration target. UI replaces its running buffer with this so the
  // plan extraction sees the corrected JSON. See agent/duration_enforcer.py.
  | { type: "plan_corrected"; text: string }
  | { type: "done" }
  | { type: "heartbeat"; t?: number }
  | { type: "error"; message: string; trace?: string };

export type AgentTurnInput = {
  knowledge_store_id: string;
  prompt: string;
  session_id?: string;
};

const RUNTIME_ARN  = (import.meta.env.VITE_AGENT_RUNTIME_ARN || "").trim();
const RUNTIME_REGION = (import.meta.env.VITE_AGENT_RUNTIME_REGION || "us-east-1").trim();
const RUNTIME_QUALIFIER = (import.meta.env.VITE_AGENT_RUNTIME_QUALIFIER || "DEFAULT").trim();

export const agentEnabled = () => Boolean(RUNTIME_ARN);

// AgentCore session IDs must be ≥33 chars. Browsers may pass undefined for
// the first turn — server picks one and returns it on the result frame, then
// the UI threads it through for follow-ups.
function buildWsUrl(sessionId?: string): string {
  const encodedArn = encodeURIComponent(RUNTIME_ARN);
  const qs = new URLSearchParams();
  qs.set("qualifier", RUNTIME_QUALIFIER);
  if (sessionId) qs.set("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", sessionId);
  return `wss://bedrock-agentcore.${RUNTIME_REGION}.amazonaws.com/runtimes/${encodedArn}/ws?${qs.toString()}`;
}

// Browser-side base64url (no padding) for the JWT subprotocol trick.
function base64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Stream a turn over the native AgentCore WS. Yields events until the
 *  agent sends `done` or `error`, or the socket closes. */
export async function* streamAgentTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
  if (!RUNTIME_ARN) throw new Error("VITE_AGENT_RUNTIME_ARN not set");

  const token = await getAccessToken();
  if (!token) throw new Error("not authenticated — Cognito access token required");

  const url = buildWsUrl(input.session_id);
  // Two subprotocols per the AgentCore browser-OAuth spec:
  //   1. `base64UrlBearerAuthorization.<base64url(jwt)>` carries the token.
  //   2. The sentinel `base64UrlBearerAuthorization` is what the runtime
  //      negotiates back; without it the handshake is rejected.
  const ws = new WebSocket(url, [
    `base64UrlBearerAuthorization.${base64url(token)}`,
    "base64UrlBearerAuthorization",
  ]);

  const queue: AgentEvent[] = [];
  let resolveNext: ((v: AgentEvent | null) => void) | null = null;
  let done = false;
  let err: Error | null = null;

  ws.onmessage = (ev) => {
    // AgentCore native WS sends one JSON object per text frame, but accept
    // newline-separated for safety (matches what the previous chat-lambda
    // path occasionally did under back-pressure).
    const lines = String(ev.data).split("\n").map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as AgentEvent;
        if (resolveNext) { const r = resolveNext; resolveNext = null; r(obj); }
        else queue.push(obj);
      } catch { /* skip malformed */ }
    }
  };
  ws.onerror = () => {
    err = new Error("WebSocket error (handshake or transport)");
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); }
  };
  ws.onclose = (ev) => {
    done = true;
    // 1008 = policy violated (auth fail or quota), 1011 = server error
    if (ev.code !== 1000 && !err) {
      err = new Error(`WS closed (code=${ev.code} reason=${ev.reason || "—"})`);
    }
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); }
  };

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    setTimeout(() => rej(new Error("WS connect timeout")), 10_000);
  });

  // First frame = the agent payload. The Strands agent in the runtime container
  // reads it via `await websocket.receive_text()` in ws_handler.
  ws.send(JSON.stringify({
    knowledge_store_id: input.knowledge_store_id,
    prompt: input.prompt,
    // access_token is forwarded so the agent can call the MCP Gateway as the
    // user when MCP mode is enabled. The runtime ALREADY verified this token
    // at the gateway, but the inner agent re-uses it for outbound auth.
    access_token: token,
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
