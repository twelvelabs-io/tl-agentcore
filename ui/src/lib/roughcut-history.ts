// Per-browser archive of generated rough cuts AND free-form Agent
// sessions. Stored in localStorage as a single mixed list so the History
// drawer can render them together in chronological order. We cap at 30
// entries; plans + chat threads are small, but unbounded growth
// eventually trips the 5MB localStorage ceiling.

import type { RoughCutPlan } from "./edl";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type RoughCutHistoryEntry = {
  kind: "rough_cut";
  id: string;
  created_at: number;
  title: string;
  script: string;
  fps: number;
  plan: RoughCutPlan;
  ks_id?: string;
  ks_name?: string;
  render?: { job_id: string; render_id?: string; output_url?: string; status: string };
  /** AgentCore runtime session id; reused across follow-up turns so the
   *  runtime keeps conversation state in its own backing store. */
  session_id?: string;
  /** Conversation thread so far. The latest assistant message has the
   *  prose-only response (the <plan> block has been stripped). */
  messages?: ChatMessage[];
};

export type AgentHistoryEntry = {
  kind: "agent";
  id: string;
  created_at: number;
  /** First user question — used as the entry's display title. */
  title: string;
  session_id?: string;
  ks_id?: string;
  ks_name?: string;
  turns: AgentTurnSnapshot[];
};

export type AgentTurnSnapshot = {
  id: string;
  role: "user" | "assistant";
  text: string;
  elapsedMs?: number;
};

export type HistoryEntry = RoughCutHistoryEntry | AgentHistoryEntry;

const KEY = "tl-agentcore.roughcut.history.v1";
const MAX = 30;

function read(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Back-compat: older entries had no `kind` field; they were all
    // rough cuts. Stamp them so the new union type holds.
    return parsed.map((e: any) => ({ kind: "rough_cut", ...e })) as HistoryEntry[];
  } catch { return []; }
}

function write(list: HistoryEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch {}
}

export function loadHistory(): HistoryEntry[] {
  return read().sort((a, b) => b.created_at - a.created_at);
}

export function saveEntry<T extends HistoryEntry>(entry: Omit<T, "id" | "created_at">): T {
  const full = {
    ...entry,
    id: Math.random().toString(36).slice(2, 8) + Date.now().toString(36),
    created_at: Date.now(),
  } as T;
  write([full, ...read()]);
  return full;
}

export function updateEntry<T extends HistoryEntry>(id: string, patch: Partial<T>): T | undefined {
  const list = read();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return undefined;
  const next = { ...list[i], ...patch } as T;
  list[i] = next;
  write(list);
  return next;
}

export function deleteEntry(id: string): void {
  write(read().filter((e) => e.id !== id));
}

export function clearHistory(): void {
  try { localStorage.removeItem(KEY); } catch {}
}

/** "12s ago" / "3m ago" / "Jan 6 · 2:34pm" — keeps the strip readable. */
export function relativeTime(ms: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
