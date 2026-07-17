import { useState } from "react";
import { setState, useStore } from "../lib/store";
import { createKnowledgeStore, type KS } from "../lib/api";

export function KSPicker() {
  const ks = useStore((s) => s.ks);
  const ksList = useStore((s) => s.ksList);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // A freshly-created KS becomes the active one immediately — no reload,
  // no manual re-pick. Persisted to localStorage by App's existing effect
  // on `ks?._id` change.
  const handleCreated = (created: KS) => {
    setState({ ksList: [...ksList, created], ks: created });
    setCreating(false);
    setOpen(false);
  };

  // Empty-fleet state: no knowledge stores exist yet. This used to be a
  // dead-end label ("no knowledge stores yet") with no way forward — the
  // create API existed but nothing in the UI called it. Now it's the
  // entry point.
  if (!ksList.length) {
    return (
      <div className="relative text-right">
        {!creating ? (
          <button
            className="label hover:text-[var(--color-cue)] transition-colors"
            onClick={() => setCreating(true)}
          >
            + create your first knowledge base
          </button>
        ) : (
          <div
            className="absolute right-0 mt-1 z-30 w-[340px] p-4 text-left"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}
          >
            <CreateKSForm onCreated={handleCreated} onCancel={() => setCreating(false)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative">
      <button className="text-right" onClick={() => setOpen((v) => !v)}>
        <div className="label">Knowledge base</div>
        <div className="font-display text-xl mt-0.5 flex items-baseline gap-2">
          <span style={{ color: "var(--color-ink)" }}>{ks?.name || "—"}</span>
          <span className="font-mono text-xs" style={{ color: "var(--color-ink-faint)" }}>
            {open ? "▲" : "▼"}
          </span>
        </div>
        {ks && (
          <div className="font-mono text-[10px]" style={{ color: "var(--color-ink-faint)" }}>
            {ks._id.slice(0, 28)}…
          </div>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 mt-2 z-30 w-[360px] py-2"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}
        >
          {ksList.map((k) => (
            <button
              key={k._id}
              className="block w-full text-left px-4 py-3 hover:bg-[var(--color-surface-2)]"
              onClick={() => { setState({ ks: k }); setOpen(false); }}
            >
              <div className="font-display text-base">{k.name}</div>
              <div className="font-mono text-[10px] mt-0.5" style={{ color: "var(--color-ink-faint)" }}>
                {k._id} · {k.item_count ?? 0} items
              </div>
            </button>
          ))}
          <div className="mt-1 pt-1 border-t" style={{ borderColor: "var(--color-rule)" }}>
            {!creating ? (
              <button
                className="block w-full text-left px-4 py-3 label hover:bg-[var(--color-surface-2)]"
                style={{ color: "var(--color-cue)" }}
                onClick={() => setCreating(true)}
              >
                + New knowledge store
              </button>
            ) : (
              <div className="px-4 py-3">
                <CreateKSForm onCreated={handleCreated} onCancel={() => setCreating(false)} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Small inline form shared by both the empty-fleet state and the "+ New
// knowledge store" row inside the populated dropdown. Autofocuses the
// name field, submits on Enter, surfaces API errors inline.
function CreateKSForm({
  onCreated, onCancel,
}: {
  onCreated: (ks: KS) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true); setErr(null);
    try {
      const created = await createKnowledgeStore(trimmed, description.trim() || undefined);
      onCreated(created);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="label mb-2" style={{ color: "var(--color-cue)" }}>new knowledge base</div>
      <input
        autoFocus
        type="text"
        placeholder="Name (e.g. Q3 Trailers)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onCancel(); }}
        disabled={busy}
        className="w-full font-mono text-sm px-3 py-2 rounded-[var(--radius-card)]"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-rule)", color: "var(--color-ink)" }}
      />
      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onCancel(); }}
        disabled={busy}
        className="w-full font-mono text-sm px-3 py-2 rounded-[var(--radius-card)] mt-2"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-rule)", color: "var(--color-ink)" }}
      />
      <div className="flex items-center justify-end gap-2 mt-3">
        <button className="btn btn-sm" onClick={onCancel} disabled={busy}>cancel</button>
        <button className="btn btn-sm btn-cue" onClick={() => void submit()} disabled={busy || !name.trim()}>
          {busy ? "creating…" : "create"}
        </button>
      </div>
      {err && (
        <p className="font-mono text-xs mt-2 break-all" style={{ color: "var(--color-status-failed)" }}>{err}</p>
      )}
    </div>
  );
}
