import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { listKnowledgeStores } from "./lib/api";
import { setState, useStore } from "./lib/store";
import { cognitoEnabled, decodeIdToken, ensureSignedIn, signOut } from "./lib/auth";
import { SignInScreen } from "./components/SignInScreen";
import { RoughCut } from "./components/RoughCut";
import { AgentCore } from "./components/AgentCore";
import { Library } from "./components/Library";
import { KnowledgeGraph } from "./components/KnowledgeGraph";
import { GlobalAssetPlayer } from "./components/AssetPlayer";
import { KSPicker } from "./components/KSPicker";
import { HistoryDrawer } from "./components/HistoryDrawer";
import SettingsModal from "./components/SettingsModal";

type Tab = "rough_cut" | "agent" | "library" | "graph";

const TABS: { id: Tab; label: string; numeral: string }[] = [
  { id: "rough_cut", label: "Rough Cut", numeral: "I"   },
  { id: "agent",     label: "Agent",     numeral: "II"  },
  { id: "library",   label: "Library",   numeral: "III" },
  { id: "graph",     label: "Graph",     numeral: "IV"  },
];

// Two persisted UI keys — survive across refreshes so producers don't lose
// their place on every reload. The KS picker also reads/writes
// LS_LAST_KS_ID via the store boot effect below.
const LS_LAST_TAB   = "tl-agentcore.lastTab";
const LS_LAST_KS_ID = "tl-agentcore.lastKsId";

function loadLastTab(): Tab {
  try {
    const v = localStorage.getItem(LS_LAST_TAB);
    if (v === "rough_cut" || v === "agent" || v === "library" || v === "graph") return v;
  } catch {}
  return "rough_cut";
}

export function App() {
  const [tab, setTabState] = useState<Tab>(() => loadLastTab());
  const setTab = (t: Tab) => {
    setTabState(t);
    try { localStorage.setItem(LS_LAST_TAB, t); } catch {}
  };
  const [bootError, setBootError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!cognitoEnabled());
  // Distinct from authReady: authChecked means "we attempted to silently
  // restore tokens once; if there weren't any, we now know to render the
  // SignInScreen." Without this, the page would briefly flash empty
  // chrome before the sign-in form mounts.
  const [authChecked, setAuthChecked] = useState(!cognitoEnabled());
  const ready = useStore((s) => s.ready);
  const ks = useStore((s) => s.ks);
  const historyOpen = useStore((s) => s.historyOpen);

  useEffect(() => {
    if (!cognitoEnabled()) return;
    ensureSignedIn()
      .then((tokens) => { if (tokens) setAuthReady(true); })
      .catch((e) => setBootError(`Sign-in failed: ${String(e?.message || e)}`))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!authReady) return;
    listKnowledgeStores()
      .then((ksList) => {
        // Restore the last-picked KS if it still exists; otherwise fall
        // back to the first row. Survives across refreshes.
        let lastKsId: string | null = null;
        try { lastKsId = localStorage.getItem(LS_LAST_KS_ID); } catch {}
        const restored = lastKsId ? ksList.find((k) => k._id === lastKsId) : undefined;
        setState({ ksList, ready: true, ks: restored || ksList[0] });
      })
      .catch((e) => setBootError(String(e)));
  }, [authReady]);

  // Persist KS selection whenever the active store changes.
  useEffect(() => {
    if (!ks?._id) return;
    try { localStorage.setItem(LS_LAST_KS_ID, ks._id); } catch {}
  }, [ks?._id]);

  // ESC closes the history drawer regardless of which tab is mounted.
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState({ historyOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  // Three-pane studio shell. No page-level scroll: html/body are
  // overflow:hidden (see app.css); each pane is responsible for its own
  // internal scroll where content overflows.
  //
  // The History drawer is rendered at this level so it works from both
  // the Rough Cut studio and the Agent tab. The trigger button is
  // in-page (left rail header of each child component); the drawer
  // handles its own visibility from the global historyOpen flag.

  // Not signed in yet (silent token restore finished, no tokens) → render
  // the local sign-in screen. On success it flips authReady, which lets
  // the next effect listKnowledgeStores() and the studio shell takes over.
  if (cognitoEnabled() && authChecked && !authReady && !bootError) {
    return (
      <SignInScreen
        onSignedIn={() => {
          setAuthReady(true);
          setBootError(null);
        }}
      />
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col" style={{ background: "var(--color-paper)" }}>
      <Masthead tab={tab} setTab={setTab} bootError={bootError} ready={ready} />

      <main className="flex-1 min-h-0 flex">
        {bootError && <FullPaneMessage><BootError msg={bootError} /></FullPaneMessage>}
        {!bootError && !ready && <FullPaneMessage><Booting /></FullPaneMessage>}
        {ready && !ks && <FullPaneMessage><NoKS /></FullPaneMessage>}

        {ready && ks && (
          <div className="flex-1 min-h-0 min-w-0">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                className="h-full"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
              >
                {tab === "rough_cut" && <RoughCut />}
                {tab === "agent"     && <AgentCore />}
                {tab === "library"   && <Library />}
                {tab === "graph"     && <KnowledgeGraph />}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </main>

      <HistoryDrawer
        onRestore={(entry) => {
          // Switch tabs and stash the entry in the global store. The
          // target tab component picks it up on its next render via a
          // useEffect that consumes + clears `pendingRestore`. This is
          // race-free even on a cold mount (vs. a setTimeout-dispatched
          // event, which can fire before the target useEffect attaches
          // its window listener).
          setTab(entry.kind === "rough_cut" ? "rough_cut" : "agent");
          setState({ pendingRestore: entry, historyOpen: false });
        }}
      />

      <GlobalAssetPlayer />
    </div>
  );
}

function FullPaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-12">
      <div className="max-w-2xl w-full">{children}</div>
    </div>
  );
}

function Masthead({ tab, setTab, bootError, ready }: { tab: Tab; setTab: (t: Tab) => void; bootError: string | null; ready: boolean }) {
  const id = decodeIdToken();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <header className="px-8 py-4 border-b flex items-center gap-8" style={{ borderColor: "var(--color-rule)" }}>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }}
        className="flex items-center gap-3"
      >
        <TLLogoMark />
        <span style={{ color: "var(--color-ink-faint)", fontSize: 14 }}>×</span>
        <h1 className="font-display text-2xl tracking-tight">
          Rough Cut<span style={{ color: "var(--color-warm)" }}>·</span>Lab
        </h1>
      </motion.div>

      <div className="flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab flex items-baseline gap-2"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span className="font-mono text-[10px]" style={{ color: "var(--color-ink-faint)" }}>{t.numeral}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-5">
        <KSPicker />
        <div className="label flex items-center" style={{ color: ready ? "var(--color-status-ready)" : "var(--color-status-pending)" }}>
          <span className={`pip ${ready ? "pip-ready" : "pip-pending"}`} />
          {bootError ? "offline" : ready ? "live" : "connecting"}
        </div>
        {id?.email && (
          <UserMenu email={id.email} onOpenSettings={() => setSettingsOpen(true)} />
        )}
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}

// Email handle becomes a tiny dropdown trigger — Settings + Sign out. Close
// on outside click or Esc. Keeps the masthead text-only (no icons), which
// matches the rest of the chrome.
function UserMenu({ email, onOpenSettings }: { email: string; onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={wrapRef}>
      <button
        className="label hover:text-[var(--color-ink)] transition-colors"
        onClick={() => setOpen((v) => !v)}
        title={`signed in as ${email}`}
      >
        {email.split("@")[0]} ▾
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="min-w-[180px]"
            style={{
              // Inline `position: absolute` beats `.grain`'s `position: relative`
              // (same selector specificity, but inline always wins). Without this
              // the dropdown rendered as a flex child and stretched the masthead.
              position: "absolute",
              right: 0,
              top: "100%",
              marginTop: 8,
              background: "var(--color-paper)",
              border: "1px solid var(--color-rule)",
              borderRadius: "var(--radius-card)",
              zIndex: 40,
            }}
          >
            <div className="px-3 py-2 border-b" style={{ borderColor: "var(--color-rule)" }}>
              <div className="label" style={{ color: "var(--color-cue)" }}>signed in</div>
              <div className="font-mono text-[11px] mt-0.5 truncate" style={{ color: "var(--color-ink-soft)" }}>{email}</div>
            </div>
            <button
              className="w-full text-left px-3 py-2 label hover:text-[var(--color-ink)]"
              onClick={() => { setOpen(false); onOpenSettings(); }}
            >
              Settings
            </button>
            <button
              className="w-full text-left px-3 py-2 label hover:text-[var(--color-ink)]"
              onClick={() => { setOpen(false); signOut(); }}
            >
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BootError({ msg }: { msg: string }) {
  return (
    <div className="border p-8 rounded-[var(--radius-card)]" style={{ borderColor: "var(--color-status-failed)" }}>
      <div className="label" style={{ color: "var(--color-status-failed)" }}>Connection failed</div>
      <p className="font-display text-2xl mt-2">The lab can't reach api.twelvelabs.io.</p>
      <p className="mt-4 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Check that the proxy is running (<span className="font-mono">npm run proxy</span>) and that{" "}
        <span className="font-mono">TL_API_KEY</span> is set in the parent project's{" "}
        <span className="font-mono">.env</span>.
      </p>
      <pre className="font-mono text-xs mt-6 p-4 rounded-[var(--radius-card)]" style={{ background: "var(--color-surface)", color: "var(--color-ink-soft)", whiteSpace: "pre-wrap" }}>{msg}</pre>
    </div>
  );
}

function Booting() {
  return (
    <div>
      <div className="label">Loading</div>
      <p className="font-display text-3xl mt-2 caret">Reading your knowledge stores</p>
    </div>
  );
}

function NoKS() {
  return (
    <div>
      <div className="label">No knowledge base selected</div>
      <p className="font-display text-3xl mt-3 max-w-xl leading-tight">
        Pick a knowledge base from the picker above to begin.
      </p>
      <p className="mt-6 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        First time? Run <span className="font-mono">scripts/ingest_vectors.py &lt;ks_id&gt;</span> to build
        the Marengo clip-embedding index in S3 Vectors. The agent searches that
        index per beat.
      </p>
    </div>
  );
}

// Right-edge handle that opens / closes the live-architecture rail.
// Slides with the panel: pinned to the viewport's right edge when the
// panel is closed; pinned to the panel's left edge (right: 320px) when
// it's open. Exported so the per-tab roots (RoughCut, AgentCore) can
// render it alongside their grid — placing it in each tab keeps it
// hidden on tabs that don't use the rail (Library, Graph).
export function ArchHandle() {
  const archOpen = useStore((s) => s.archOpen);
  return (
    <button
      onClick={() => setState({ archOpen: !archOpen })}
      title={archOpen ? "Hide live architecture" : "Show live architecture"}
      aria-pressed={archOpen}
      aria-label="Toggle live architecture rail"
      className="group hover:text-[var(--color-cue)] transition-all"
      style={{
        position: "fixed",
        right: archOpen ? 320 : 0,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 40,
        width: 22,
        height: 96,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--color-surface)",
        border: "1px solid var(--color-rule)",
        borderRight: archOpen ? "1px solid var(--color-rule)" : "none",
        borderTopLeftRadius: 10,
        borderBottomLeftRadius: 10,
        borderTopRightRadius: archOpen ? 0 : 0,
        borderBottomRightRadius: archOpen ? 0 : 0,
        color: "var(--color-ink-soft)",
        cursor: "pointer",
        boxShadow: archOpen ? "none" : "-2px 0 8px -4px rgba(0,0,0,0.25)",
        transition: "right 220ms cubic-bezier(0.2,0,0,1), color 150ms",
      }}
    >
      <span
        className="font-mono text-xs"
        style={{
          display: "inline-block",
          transition: "transform 220ms cubic-bezier(0.2,0,0,1)",
          transform: archOpen ? "rotate(180deg)" : "rotate(0deg)",
        }}
      >
        ‹
      </span>
      <span
        className="label sr-only"
        style={{ writingMode: "vertical-rl" as const, transform: "rotate(180deg)" }}
      >
        live arch
      </span>
    </button>
  );
}

// TwelveLabs logo mark — same pixel-grid silhouette used in the favicon
// and across the TL platform UIs. Inlined as JSX (rather than imported
// SVG) so it inherits `currentColor` and we can scale + color it without
// fetching an extra asset. Original geometry lives in
// packages/strand/assets/logos/logo-mark.svg in the Lasso repo.
function TLLogoMark({ height = 22, color = "var(--color-ink)" }: { height?: number; color?: string }) {
  // 50.27 × 36 native viewBox; scale to the requested height.
  const w = (50.27 / 36) * height;
  return (
    <svg
      viewBox="0 0 50.27 36"
      height={height}
      width={w}
      role="img"
      aria-label="TwelveLabs"
      style={{ color, display: "block" }}
    >
      <g fill="currentColor">
        <rect x="10.83" y="12.36" width="15.89" height="2.14" rx="0.63" />
        <rect x="0.00"  y="12.36" width="8.71"  height="2.14" rx="0.63" />
        <rect x="30.67" y="12.36" width="9.94"  height="2.14" rx="0.63" />
        <rect x="32.10" y="9.28"  width="8.52"  height="2.15" rx="0.63" />
        <rect x="41.74" y="9.28"  width="6.76"  height="2.15" rx="0.63" />
        <rect x="38.86" y="6.14"  width="7.70"  height="2.15" rx="0.63" />
        <rect x="41.30" y="3.07"  width="2.26"  height="2.15" rx="0.63" />
        <rect x="18.36" y="27.71" width="3.92"  height="2.15" rx="0.63" />
        <rect x="25.16" y="27.71" width="2.56"  height="2.15" rx="0.63" />
        <rect x="28.91" y="27.71" width="6.92"  height="2.15" rx="0.63" />
        <rect x="32.38" y="24.64" width="2.87"  height="2.14" rx="0.63" />
        <rect x="12.96" y="27.71" width="2.26"  height="2.15" rx="0.63" />
        <rect x="23.41" y="30.78" width="2.26"  height="2.15" rx="0.63" />
        <rect x="21.19" y="33.86" width="2.16"  height="2.14" rx="0.63" />
        <rect x="29.75" y="0.00"  width="2.81"  height="2.15" rx="0.63" />
        <rect x="13.79" y="9.28"  width="7.18"  height="2.15" rx="0.63" />
        <rect x="27.10" y="3.07"  width="4.36"  height="2.15" rx="0.63" />
        <rect x="24.42" y="6.14"  width="7.03"  height="2.15" rx="0.63" />
        <rect x="46.30" y="12.36" width="4.11"  height="2.14" rx="0.63" />
        <rect x="7.56"  y="15.43" width="20.28" height="2.15" rx="0.63" />
        <rect x="25.97" y="21.57" width="7.92"  height="2.15" rx="0.63" />
        <rect x="10.83" y="18.50" width="25.76" height="2.15" rx="0.63" />
        <rect x="6.89"  y="21.57" width="9.58"  height="2.15" rx="0.63" />
        <rect x="15.64" y="24.64" width="3.14"  height="2.14" rx="0.63" />
        <rect x="26.72" y="24.64" width="3.38"  height="2.14" rx="0.63" />
        <rect x="9.84"  y="24.64" width="3.18"  height="2.14" rx="0.63" />
        <rect x="30.67" y="15.43" width="8.19"  height="2.15" rx="0.63" />
        <rect x="32.57" y="6.12"  width="2.26"  height="2.15" rx="0.63" />
      </g>
    </svg>
  );
}
