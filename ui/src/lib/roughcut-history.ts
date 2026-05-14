// Per-browser archive of generated rough cuts. Stored in localStorage so a
// reload (or a re-deploy) doesn't wipe the producer's work. We cap at 20
// entries — plans are small, but unbounded growth eventually trips the 5MB
// localStorage ceiling.

import type { RoughCutPlan } from "./edl";

export type RoughCutHistoryEntry = {
  id: string;
  created_at: number;
  title: string;
  script: string;
  fps: number;
  plan: RoughCutPlan;             // primary plan (Jockey-direct in compare mode)
  ks_id?: string;
  ks_name?: string;
  render?: { job_id: string; render_id?: string; output_url?: string; status: string };
  /** "jockey" | "agent" | "compare". Older entries don't have this — treat as "jockey". */
  mode?: "jockey" | "agent" | "compare";
  /** Populated for compare entries — both sides' results, including timing + errors. */
  compare?: {
    jockey: { plan: RoughCutPlan | null; elapsed_ms: number; err?: string };
    agent:  { plan: RoughCutPlan | null; elapsed_ms: number; err?: string };
  };
};

const KEY = "jocky.roughcut.history.v1";
const MAX = 20;

function read(): RoughCutHistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function write(list: RoughCutHistoryEntry[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch {}
}

export function loadHistory(): RoughCutHistoryEntry[] {
  return read();
}

export function saveEntry(entry: Omit<RoughCutHistoryEntry, "id" | "created_at">): RoughCutHistoryEntry {
  const full: RoughCutHistoryEntry = {
    ...entry,
    id: Math.random().toString(36).slice(2, 8) + Date.now().toString(36),
    created_at: Date.now(),
  };
  write([full, ...read()]);
  return full;
}

export function updateEntry(id: string, patch: Partial<RoughCutHistoryEntry>): RoughCutHistoryEntry | undefined {
  const list = read();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return undefined;
  const next = { ...list[i], ...patch };
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
