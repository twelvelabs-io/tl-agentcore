// Settings API — view/edit the system prompts the agent + ingest pipeline use.
// Backed by the settings lambda (/settings/prompts) → kb_cache DDB.

import { getAccessToken } from "./auth";

const BASE = "/settings";

export type PromptId = "agent_system" | "pegasus_profile";

export type PromptInfo = {
  label: string;
  description: string;
  source: string;
  default: string;
  current: string;
  overridden: boolean;
  updated_at: number | null;
  updated_by: string | null;
};

export type PromptsResponse = {
  prompts: Record<PromptId, PromptInfo>;
};

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const detail = typeof data === "string" ? data : data?.error || data?.message || JSON.stringify(data);
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return data as T;
}

export const fetchPrompts = () =>
  call<PromptsResponse>("GET", "/prompts");

export const savePrompt = (id: PromptId, text: string) =>
  call<PromptsResponse>("PUT", `/prompts/${id}`, { text });

export const resetPrompt = (id: PromptId) =>
  call<PromptsResponse>("DELETE", `/prompts/${id}`);
