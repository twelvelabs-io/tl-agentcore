// Persistent timeline strip anchored at the bottom of the shell.
// Visual-only in PR 1: the stage waiting for a cut. In PR 2 it becomes
// the live EDL preview (clips land here as the agent assembles them).
//
// Why it exists even when empty: the strip is the brand's structural
// signature. Having it visible from the first paint tells the producer
// "this is where the cut will be," before any content exists. Removing
// it when empty would make the shell feel like a generic SaaS layout.

import { useState } from "react";

type Mark = { t: string; label?: string };

const EMPTY_MARKS: Mark[] = [
  { t: "00:00:00", label: "head" },
  { t: "00:00:30" },
  { t: "00:01:00" },
  { t: "00:01:30" },
  { t: "00:02:00" },
  { t: "00:02:30" },
  { t: "00:03:00" },
  { t: "00:03:30" },
  { t: "00:04:00" },
  { t: "00:04:30", label: "tail" },
];

export function TimelineStrip() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div
      style={{
        flex: `0 0 ${collapsed ? 24 : 72}px`,
        background: "var(--cr-film-black)",
        borderTop: "1px solid var(--cr-slate)",
        color: "var(--cr-mist)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: 1.2,
        transition: "flex-basis 220ms cubic-bezier(0.2, 0, 0, 1)",
        display: "flex",
        alignItems: "stretch",
      }}
      aria-label="Rough cut timeline"
    >
      <button
        onClick={() => setCollapsed(v => !v)}
        aria-pressed={collapsed}
        title={collapsed ? "Show timeline" : "Hide timeline"}
        style={{
          width: 46,
          borderRight: "1px solid var(--cr-slate)",
          background: "transparent",
          color: "var(--cr-mist)",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 10,
          letterSpacing: 1.2,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {collapsed ? "edl ▴" : "edl ▾"}
      </button>

      {!collapsed && (
        <div style={{ flex: 1, position: "relative", padding: "10px 20px 8px" }}>
          {/* Ruler */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 20,
              right: 20,
              top: 10,
              height: 1,
              background: "var(--cr-slate)",
            }}
          />
          {/* Ticks */}
          <div style={{ display: "flex", justifyContent: "space-between", position: "relative" }}>
            {EMPTY_MARKS.map((m, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div
                  aria-hidden
                  style={{
                    width: 1,
                    height: m.label ? 10 : 6,
                    background: m.label ? "var(--cr-pulse)" : "var(--cr-slate-2)",
                  }}
                />
                <div style={{ marginTop: 6, color: m.label ? "var(--cr-grade-ink)" : "var(--cr-mist)" }}>{m.t}</div>
                {m.label && <div style={{ fontSize: 9, color: "var(--cr-pulse)", marginTop: 2 }}>{m.label}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {!collapsed && (
        <div
          style={{
            width: 120,
            borderLeft: "1px solid var(--cr-slate)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--cr-mist)",
          }}
        >
          <span style={{ opacity: 0.7 }}>no cut yet</span>
        </div>
      )}
    </div>
  );
}
