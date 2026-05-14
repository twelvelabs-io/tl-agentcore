import { useState } from "react";
import { setState, useStore } from "../lib/store";

export function KSPicker() {
  const ks = useStore((s) => s.ks);
  const ksList = useStore((s) => s.ksList);
  const [open, setOpen] = useState(false);

  if (!ksList.length) {
    return (
      <div className="label" style={{ color: "var(--color-ink-faint)" }}>
        no knowledge stores yet
      </div>
    );
  }

  return (
    <div className="relative">
      <button className="text-right" onClick={() => setOpen((v) => !v)}>
        <div className="label">Active knowledge base</div>
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
              <div className="font-mono text-[10px]" style={{ color: "var(--color-ink-faint)" }}>
                {k._id} · {k.item_count ?? 0} items
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
