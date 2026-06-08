// Cross-tab history drawer. Lives at App.tsx level so the same drawer is
// reachable from both the Rough Cut studio and the Agent tab. Stores
// rough-cut plans AND agent sessions in a single mixed list (sorted by
// recency); restoring dispatches a kind-tagged event that the matching
// child component picks up.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { setState as setGlobal, useStore } from "../lib/store";
import {
  loadHistory,
  deleteEntry,
  relativeTime,
  type HistoryEntry,
  type RoughCutHistoryEntry,
  type AgentHistoryEntry,
} from "../lib/roughcut-history";
import { fmtDuration, totalDuration } from "../lib/edl";

export function HistoryDrawer({ onRestore }: { onRestore: (entry: HistoryEntry) => void }) {
  const open = useStore((s) => s.historyOpen);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  // Reload entries every time the drawer opens, and any time a child
  // dispatches "history:updated" after a save. Cheap; localStorage read.
  useEffect(() => {
    if (open) setEntries(loadHistory());
  }, [open]);
  useEffect(() => {
    const onUpdate = () => setEntries(loadHistory());
    window.addEventListener("history:updated", onUpdate);
    return () => window.removeEventListener("history:updated", onUpdate);
  }, []);

  const handleDelete = (id: string) => {
    deleteEntry(id);
    setEntries(loadHistory());
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40"
            style={{ background: "rgba(0,0,0,0.5)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setGlobal({ historyOpen: false })}
          />
          <motion.aside
            className="fixed top-0 right-0 bottom-0 w-[400px] z-50 flex flex-col border-l"
            style={{ background: "var(--color-paper)", borderColor: "var(--color-rule)" }}
            initial={{ x: 420 }}
            animate={{ x: 0 }}
            exit={{ x: 420 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <div className="px-5 py-4 border-b flex items-baseline justify-between" style={{ borderColor: "var(--color-rule)" }}>
              <div>
                <div className="label">§ History</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--color-ink-soft)" }}>
                  {entries.length} saved cut{entries.length === 1 ? "" : "s"} · stored locally
                </div>
              </div>
              <button
                className="label text-lg hover:text-[var(--color-ink)] transition-colors"
                onClick={() => setGlobal({ historyOpen: false })}
                aria-label="close history"
              >
                ×
              </button>
            </div>
            <div
              className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3"
              tabIndex={0}
              role="region"
              aria-label="Saved cuts"
            >
              {entries.length === 0 && (
                <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
                  No saved cuts yet. Generate a rough cut or run an Agent
                  session and they'll show up here automatically.
                </p>
              )}
              {entries.map((e) =>
                e.kind === "agent"
                  ? <AgentCard key={e.id} entry={e} onClick={() => onRestore(e)} onDelete={() => handleDelete(e.id)} />
                  : <RoughCutCard key={e.id} entry={e} onClick={() => onRestore(e)} onDelete={() => handleDelete(e.id)} />
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function RoughCutCard({ entry, onClick, onDelete }: { entry: RoughCutHistoryEntry; onClick: () => void; onDelete: () => void }) {
  const sceneCount = entry.plan.scenes.length;
  const clipCount = entry.plan.scenes.reduce((s, sc) => s + (sc.clips?.length || 0), 0);
  const dur = totalDuration(entry.plan);
  const rendered = entry.render?.status === "COMPLETE" && entry.render.output_url;
  return (
    <div
      className="border p-3 rounded-[var(--radius-card)] cursor-pointer transition-colors hover:bg-[var(--color-surface)]"
      style={{ borderColor: "var(--color-rule)" }}
      data-kind="rough_cut"
      onClick={onClick}
    >
      <Header kind="rough_cut" createdAt={entry.created_at} onDelete={onDelete} />
      <div className="font-display text-base leading-tight mt-1 truncate" title={entry.title}>
        {entry.title}
      </div>
      <div className="font-mono text-[10px] mt-2" style={{ color: "var(--color-ink-soft)" }}>
        {sceneCount} scenes · {clipCount} clips · {fmtDuration(dur)} · {entry.fps}fps
      </div>
      {entry.ks_name && (
        <div className="font-mono text-[10px] mt-1 truncate" style={{ color: "var(--color-ink-faint)" }}>
          {entry.ks_name}
        </div>
      )}
      {rendered && (
        <div className="mt-2 label" style={{ color: "var(--color-status-ready)" }}>
          ✓ rendered
        </div>
      )}
    </div>
  );
}

function AgentCard({ entry, onClick, onDelete }: { entry: AgentHistoryEntry; onClick: () => void; onDelete: () => void }) {
  const userTurns = entry.turns.filter((t) => t.role === "user").length;
  const assistantTurns = entry.turns.filter((t) => t.role === "assistant" && t.text).length;
  return (
    <div
      className="border p-3 rounded-[var(--radius-card)] cursor-pointer transition-colors hover:bg-[var(--color-surface)]"
      style={{ borderColor: "var(--color-rule)" }}
      data-kind="agent"
      onClick={onClick}
    >
      <Header kind="agent" createdAt={entry.created_at} onDelete={onDelete} />
      <div className="font-display text-base leading-tight mt-1" title={entry.title}>
        "{entry.title.length > 80 ? entry.title.slice(0, 80) + "…" : entry.title}"
      </div>
      <div className="font-mono text-[10px] mt-2" style={{ color: "var(--color-ink-soft)" }}>
        {userTurns} question{userTurns === 1 ? "" : "s"} · {assistantTurns} response{assistantTurns === 1 ? "" : "s"}
      </div>
      {entry.ks_name && (
        <div className="font-mono text-[10px] mt-1 truncate" style={{ color: "var(--color-ink-faint)" }}>
          {entry.ks_name}
        </div>
      )}
    </div>
  );
}

function Header({ kind, createdAt, onDelete }: { kind: "rough_cut" | "agent"; createdAt: number; onDelete: () => void }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-[9px] px-1.5 py-0.5 rounded"
          style={{
            background: kind === "agent" ? "color-mix(in oklch, var(--color-warm) 18%, transparent)" : "var(--color-surface-2)",
            color: kind === "agent" ? "var(--color-warm)" : "var(--color-ink-soft)",
            letterSpacing: 0,
          }}
        >
          {kind === "agent" ? "agent" : "rough cut"}
        </span>
        <span className="label" style={{ color: "var(--color-ink-faint)" }}>
          {relativeTime(createdAt)}
        </span>
      </div>
      <button
        className="label text-base hover:text-[var(--color-status-failed)] transition-colors"
        style={{ color: "var(--color-ink-faint)" }}
        onClick={(ev) => { ev.stopPropagation(); onDelete(); }}
        title="remove from history"
      >
        ×
      </button>
    </div>
  );
}
