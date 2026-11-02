// First-visit slate intro — the one orchestrated motion moment in the app.
// Plays once per browser (localStorage flag), ~2 seconds, then unmounts.
// Respects prefers-reduced-motion: shows the brand card briefly, no clap.
//
// Choreography (see also docs/whitepaper § hero sequence):
//   0.00s  cover fades in over --cr-film-black
//   0.15s  slate card lands (spring, scale 0.96 → 1)
//   0.60s  slate "claps" — brief pulse strike across the top
//   1.00s  slate dissolves to the serif brand lockup
//   1.35s  tagline fades in under it (BlurText, word stagger)
//   1.90s  cover dissolves back to transparent, calls onDone, unmounts
//
// This is the only ambient animation in the app. After this plays, motion
// is response-based only — no scroll-tied effects, no ambient backgrounds.

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import BlurText from "./bits/BlurText";

const LS_SLATE_SEEN = "tl-ui-slate-seen";

type SlatePhase = "card" | "lockup" | "done";

export function hasSeenSlate(): boolean {
  try { return localStorage.getItem(LS_SLATE_SEEN) === "1"; } catch { return true; }
}

export function markSlateSeen(): void {
  try { localStorage.setItem(LS_SLATE_SEEN, "1"); } catch {}
}

export function Slate({ onDone }: { onDone: () => void }) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<SlatePhase>("card");
  const [visible, setVisible] = useState(true);

  // Timing is kept inline so each milestone is readable.
  useEffect(() => {
    if (reduced) {
      // Reduced motion — show brand for ~500ms, no clap, no chip fan.
      const toLockup = window.setTimeout(() => setPhase("lockup"), 150);
      const toDone = window.setTimeout(() => setVisible(false), 650);
      return () => { window.clearTimeout(toLockup); window.clearTimeout(toDone); };
    }
    const toLockup = window.setTimeout(() => setPhase("lockup"), 1000);
    const toDone = window.setTimeout(() => setVisible(false), 1900);
    return () => { window.clearTimeout(toLockup); window.clearTimeout(toDone); };
  }, [reduced]);

  return (
    <AnimatePresence onExitComplete={() => { markSlateSeen(); onDone(); }}>
      {visible && (
        <motion.div
          key="slate-cover"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "var(--cr-film-black)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
          // Allow dismiss on click so a repeat-tester can skip it.
          onClick={() => setVisible(false)}
        >
          {/* Thin film-grain overlay — ties it to the rest of the app's
              darkroom aesthetic. */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              opacity: 0.06,
              mixBlendMode: "overlay",
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.7 0'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>\")",
            }}
          />

          <AnimatePresence mode="wait">
            {phase === "card" && (
              <SlateCard key="card" reduced={!!reduced} />
            )}
            {phase === "lockup" && (
              <Lockup key="lockup" reduced={!!reduced} />
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function SlateCard({ reduced }: { reduced: boolean }) {
  // Film slate card — the clapperboard metaphor. Deliberately not using
  // the real diagonal stripes; those read as costume. The card itself is
  // the signifier, held by its typographic grid: scene/take/roll on top,
  // production/dir/date below. All data placeholders are deliberate — the
  // user's identity goes in production, today's date in date, etc.
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 8 }}
      animate={reduced ? { opacity: 1, scale: 1, y: 0 } : { opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 1.02, filter: "blur(6px)" }}
      transition={{ duration: 0.4, ease: [0.2, 0.9, 0.2, 1] }}
      style={{
        width: 480,
        maxWidth: "88vw",
        padding: "28px 32px",
        background: "var(--cr-slate)",
        border: "1px solid var(--cr-slate-2)",
        color: "var(--cr-grade-ink)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        letterSpacing: 0.3,
        boxShadow: "0 24px 60px -24px rgba(0,0,0,0.6)",
        position: "relative",
      }}
    >
      {/* Clap strike — a thin pulse-colored bar that sweeps across the
          top edge once. The one place --cr-pulse appears in the slate. */}
      {!reduced && (
        <motion.div
          aria-hidden
          initial={{ scaleX: 0, originX: 0, opacity: 0 }}
          animate={{ scaleX: [0, 1, 1], opacity: [0, 1, 0] }}
          transition={{ duration: 0.5, delay: 0.5, times: [0, 0.4, 1], ease: "easeOut" }}
          style={{
            position: "absolute",
            top: -1,
            left: 0,
            right: 0,
            height: 2,
            background: "var(--cr-pulse)",
            transformOrigin: "left",
          }}
        />
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 10,
          borderBottom: "1px solid var(--cr-slate-2)",
          paddingBottom: 14,
          marginBottom: 14,
          color: "var(--cr-mist)",
        }}
      >
        <Field label="scene" value="01" />
        <Field label="take" value="01" />
        <Field label="roll" value="A" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 10, color: "var(--cr-mist)" }}>
        <Field label="production" value="Rough Cut Lab" />
        <Field label="dir" value="You" />
        <Field label="date" value={today()} />
      </div>
    </motion.div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: 1.2, color: "var(--cr-mist)" }}>{label}</div>
      <div style={{ fontSize: 13, color: "var(--cr-grade-ink)", marginTop: 2, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function Lockup({ reduced }: { reduced: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.5, ease: [0.2, 0, 0, 1] }}
      style={{ textAlign: "center", maxWidth: "min(640px, 86vw)" }}
    >
      <div
        className="display-cinema"
        style={{ fontSize: "clamp(42px, 7vw, 72px)", color: "var(--cr-grade-ink)" }}
      >
        Rough Cut <em>Lab</em>
      </div>
      {!reduced && (
        <div style={{ marginTop: 18, color: "var(--cr-mist)", fontSize: 15, fontFamily: "var(--font-body)" }}>
          <BlurText
            text="Build highlight reels from clips you already have."
            animateBy="words"
            delay={60}
            stepDuration={0.28}
            blur={6}
            distance={12}
            trigger="load"
          />
        </div>
      )}
    </motion.div>
  );
}

function today(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}·${mm}·${dd}`;
}
