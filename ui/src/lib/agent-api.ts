// Talk to the deployed AgentCore Runtime over its NATIVE WebSocket. The
// browser connects directly to wss://bedrock-agentcore.<region>.amazonaws.com
// — no chat lambda, no API Gateway, no CloudFront hop. Authentication is the
// user's Cognito access token, passed via the Sec-WebSocket-Protocol
// subprotocol trick because browsers can't set custom headers on a WS
// handshake. AgentCore Runtime is configured with a customJWTAuthorizer
// (allowed_clients = SPA client id) that verifies the token at the gateway.
//
// Wire format on the WS (Open-Responses taxonomy, matches runtime.py):
//   client → server: ONE JSON frame on connect = { knowledge_store_id, prompt, access_token? }
//   server → client: many JSON frames = Open-Responses events, each carries
//                    a monotonic `sequence_number` starting at 0. Event types:
//                      response.created
//                      response.output_item.added    (message | function_call | custom)
//                      response.output_text.delta
//                      response.output_text.done
//                      response.output_item.done
//                      response.keepalive            (every ~20s during idle)
//                      response.activity             (human-readable "doing X now"
//                                                     sentence; emitted alongside
//                                                     tool_begin events and for
//                                                     pipeline / preseed / rewoo
//                                                     narration — see
//                                                     agent/tl_agentcore/activity_narrator.py)
//                      response.completed
//                      response.failed
//                    EDL plans arrive as `custom` output items with
//                    `custom_type: "edl.plan"` and parsed JSON in `data`.
//                    The duration-enforcer rewrite emits a SECOND
//                    output_item.done with the SAME item.id — the UI
//                    replaces the previous plan in place.

import { getAccessToken } from "./auth";

// ─── Open-Responses event union ──────────────────────────────────────────────
export type ResponseMessageItem = {
  id: string;
  type: "message";
  status: "in_progress" | "completed";
  role: "assistant";
  content: Array<{ type: "output_text"; text: string }>;
};

export type ResponseFunctionCallItem = {
  id: string;
  type: "function_call";
  // runtime.py also sets "failed" when `error_code` is populated — the
  // envelope converts a tool_end with an error_code into this item shape.
  status: "in_progress" | "completed" | "failed";
  name: string;
  arguments?: string;
  output?: string;
  // Stable bucket slug from agent/tl_agentcore/error_taxonomy.py when the
  // tool raised or returned {"error": ...}. One of: unknown, not_found,
  // permission, rate_limit, throttled, validation, timeout, model_error,
  // network, config. UIs map on this, never on `output` prose.
  error_code?: string;
};

export type ResponseCustomItem = {
  id: string;
  type: "custom";
  custom_type: string;              // e.g. "edl.plan"
  status: "in_progress" | "completed";
  data?: unknown;
  correction_note?: string;
};

export type ResponseItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | ResponseCustomItem;

type ResponseErrorBody = {
  message: string;
  trace?: string;
  // Same taxonomy as ResponseFunctionCallItem.error_code — mapped on the
  // UI side via errorLabel() below.
  code?: string;
};

/** Map an error_taxonomy slug to a short human label. Falls back to the
 *  raw slug (with underscores → spaces) when the code is unknown so new
 *  taxonomy additions still render legibly. */
export function errorLabel(code?: string): string {
  if (!code) return "";
  switch (code) {
    case "rate_limit":  return "rate limited";
    case "throttled":   return "throttled";
    case "timeout":     return "timeout";
    case "not_found":   return "not found";
    case "permission":  return "no permission";
    case "validation":  return "bad input";
    case "model_error": return "model error";
    case "network":     return "network";
    case "config":      return "misconfigured";
    case "unknown":     return "failed";
    default: return code.replace(/_/g, " ");
  }
}

export type AgentEvent =
  | { type: "response.created"; sequence_number: number;
      response: { id: string; object: "response"; created_at?: number; status: string } }
  | { type: "response.output_item.added"; sequence_number: number;
      output_index: number; item: ResponseItem }
  | { type: "response.output_text.delta"; sequence_number: number;
      item_id: string; output_index: number; content_index: number; delta: string }
  | { type: "response.output_text.done"; sequence_number: number;
      item_id: string; output_index: number; content_index: number; text: string }
  | { type: "response.output_item.done"; sequence_number: number;
      output_index: number; item: ResponseItem }
  | { type: "response.keepalive"; sequence_number: number }
  | { type: "response.activity"; sequence_number: number;
      tool_use_id: string; text: string }
  | { type: "response.completed"; sequence_number: number;
      response: { id: string; object: "response"; status: "completed"; tool_path?: string } }
  | { type: "response.failed"; sequence_number: number;
      response: { id: string; object: "response"; status: "failed";
                  error: ResponseErrorBody; tool_path?: string } };

export type AgentTurnInput = {
  knowledge_store_id: string;
  prompt: string;
  session_id?: string;
};

// ─── Normalized helpers for callers that don't want to switch on the raw
// event taxonomy. extractToolName() / isTextDelta() / etc. keep component
// code tidy without hiding the underlying events. ───────────────────────────
export function toolNameFromAdded(ev: AgentEvent): string | null {
  if (ev.type !== "response.output_item.added") return null;
  if (ev.item.type !== "function_call") return null;
  return ev.item.name;
}

export function isEdlPlanItem(item: ResponseItem): item is ResponseCustomItem {
  return item.type === "custom" && item.custom_type === "edl.plan";
}

const RUNTIME_ARN  = (import.meta.env.VITE_AGENT_RUNTIME_ARN || "").trim();
const RUNTIME_REGION = (import.meta.env.VITE_AGENT_RUNTIME_REGION || "us-east-1").trim();
const RUNTIME_QUALIFIER = (import.meta.env.VITE_AGENT_RUNTIME_QUALIFIER || "DEFAULT").trim();

export const agentEnabled = () => Boolean(RUNTIME_ARN);

// AgentCore session IDs must be ≥33 chars. Browsers may pass undefined for
// the first turn — server picks one.
function buildWsUrl(sessionId?: string): string {
  const encodedArn = encodeURIComponent(RUNTIME_ARN);
  const qs = new URLSearchParams();
  qs.set("qualifier", RUNTIME_QUALIFIER);
  if (sessionId) qs.set("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", sessionId);
  return `wss://bedrock-agentcore.${RUNTIME_REGION}.amazonaws.com/runtimes/${encodedArn}/ws?${qs.toString()}`;
}

function base64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Stream a turn over the native AgentCore WS. Yields Open-Responses events
 *  until the agent sends `response.completed` or `response.failed`, or the
 *  socket closes. */
export async function* streamAgentTurn(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
  if (!RUNTIME_ARN) throw new Error("VITE_AGENT_RUNTIME_ARN not set");

  const token = await getAccessToken();
  if (!token) throw new Error("not authenticated — Cognito access token required");

  const url = buildWsUrl(input.session_id);
  const ws = new WebSocket(url, [
    `base64UrlBearerAuthorization.${base64url(token)}`,
    "base64UrlBearerAuthorization",
  ]);

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
  ws.onerror = () => {
    err = new Error("WebSocket error (handshake or transport)");
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); }
  };
  ws.onclose = (ev) => {
    done = true;
    if (ev.code !== 1000 && !err) {
      err = new Error(`WS closed (code=${ev.code} reason=${ev.reason || "—"})`);
    }
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(null); }
  };

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    setTimeout(() => rej(new Error("WS connect timeout")), 10_000);
  });

  ws.send(JSON.stringify({
    knowledge_store_id: input.knowledge_store_id,
    prompt: input.prompt,
    access_token: token,
  }));

  try {
    while (true) {
      if (queue.length) {
        const next = queue.shift()!;
        yield next;
        if (next.type === "response.completed" || next.type === "response.failed") break;
        continue;
      }
      if (done) break;
      const next = await new Promise<AgentEvent | null>((r) => { resolveNext = r; });
      if (err) throw err;
      if (next === null) break;
      yield next;
      if (next.type === "response.completed" || next.type === "response.failed") break;
    }
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}
