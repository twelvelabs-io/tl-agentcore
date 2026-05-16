import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { listKnowledgeStores } from "./lib/api";
import { setState, useStore } from "./lib/store";
import { cognitoEnabled, decodeIdToken, ensureSignedIn, signOut } from "./lib/auth";
import { RoughCut } from "./components/RoughCut";
import { AgentCore } from "./components/AgentCore";
import { GlobalAssetPlayer } from "./components/AssetPlayer";
import { KSPicker } from "./components/KSPicker";

type Tab = "rough_cut" | "agent";

const TABS: { id: Tab; label: string; numeral: string }[] = [
  { id: "rough_cut", label: "Rough Cut", numeral: "I" },
  { id: "agent",     label: "Agent",     numeral: "II" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("rough_cut");
  const [bootError, setBootError] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(!cognitoEnabled());
  const ready = useStore((s) => s.ready);
  const ks = useStore((s) => s.ks);

  useEffect(() => {
    if (!cognitoEnabled()) return;
    ensureSignedIn()
      .then((tokens) => { if (tokens) setAuthReady(true); })
      .catch((e) => setBootError(`Sign-in failed: ${String(e?.message || e)}`));
  }, []);

  useEffect(() => {
    if (!authReady) return;
    listKnowledgeStores()
      .then((ksList) => setState({ ksList, ready: true, ks: ksList[0] }))
      .catch((e) => setBootError(String(e)));
  }, [authReady]);

  return (
    <div className="grain min-h-screen w-screen flex flex-col" style={{ background: "var(--color-paper)" }}>
      <Masthead tab={tab} setTab={setTab} bootError={bootError} ready={ready} />

      <main className="flex-1 grid" style={{ gridTemplateColumns: "44px 1fr" }}>
        <div className="perforations" />
        <div className="px-10 lg:px-16 py-12 max-w-[1280px] w-full">
          {bootError && <BootError msg={bootError} />}
          {!bootError && !ready && <Booting />}
          {ready && !ks && <NoKS />}
          {ready && ks && (
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
              >
                {tab === "rough_cut" && <RoughCut />}
                {tab === "agent"     && <AgentCore />}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </main>

      <Footer />
      <GlobalAssetPlayer />
    </div>
  );
}

function Masthead({ tab, setTab, bootError, ready }: { tab: Tab; setTab: (t: Tab) => void; bootError: string | null; ready: boolean }) {
  const id = decodeIdToken();
  return (
    <header className="px-10 lg:px-16 pt-8 pb-6 border-b" style={{ borderColor: "var(--color-rule)" }}>
      <div className="flex items-end justify-between gap-8">
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.2, 0, 0, 1] }}
        >
          <div className="label" style={{ color: "var(--color-cue)" }}>
            AWS × TwelveLabs · AgentCore reference · {new Date().getFullYear()}
          </div>
          <h1 className="font-display text-5xl lg:text-6xl mt-1" style={{ fontVariationSettings: '"opsz" 144, "wght" 600, "SOFT" 50' }}>
            Rough Cut<span style={{ color: "var(--color-cue)" }}>·</span>Lab
          </h1>
          <div className="label mt-1">Agentic highlight reels on AgentCore + Marengo + Pegasus</div>
        </motion.div>
        <div className="hidden md:block"><KSPicker /></div>
      </div>

      <div className="flex items-center gap-12 mt-10 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab flex items-baseline gap-2"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span className="font-mono text-[10px] opacity-60">{t.numeral}</span>
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-6">
          {id?.email && (
            <button
              className="label hover:text-[var(--color-cue)]"
              onClick={signOut}
              title={`signed in as ${id.email} — click to sign out`}
            >
              {id.email.split("@")[0]} · sign out
            </button>
          )}
          <div className="label" style={{ color: ready ? "var(--color-status-ready)" : "var(--color-status-pending)" }}>
            <span className={`pip ${ready ? "pip-ready" : "pip-pending"}`} />
            {bootError ? "offline" : ready ? "live" : "connecting"}
          </div>
        </div>
      </div>

      <div className="md:hidden mt-6"><KSPicker /></div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="px-10 lg:px-16 py-6 border-t" style={{ borderColor: "var(--color-rule)" }}>
      <div className="flex items-center justify-between text-xs label">
        <span>tl-agentcore · AgentCore Runtime + TwelveLabs Marengo/Pegasus</span>
        <span className="font-mono normal-case tracking-normal" style={{ color: "var(--color-ink-faint)" }}>
          api.twelvelabs.io / v1.3
        </span>
      </div>
    </footer>
  );
}

function BootError({ msg }: { msg: string }) {
  return (
    <div className="border p-8" style={{ borderColor: "var(--color-status-failed)" }}>
      <div className="label" style={{ color: "var(--color-status-failed)" }}>Connection failed</div>
      <p className="font-display text-3xl mt-2">The lab can't reach api.twelvelabs.io.</p>
      <p className="mt-4 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        Check that the proxy is running (<span className="font-mono">npm run proxy</span>) and that{" "}
        <span className="font-mono">TL_API_KEY</span> is set in the parent project's{" "}
        <span className="font-mono">.env</span>.
      </p>
      <pre className="font-mono text-xs mt-6 p-4" style={{ background: "var(--color-surface)", color: "var(--color-ink-soft)", whiteSpace: "pre-wrap" }}>{msg}</pre>
    </div>
  );
}

function Booting() {
  return (
    <div className="py-32">
      <div className="label">Loading</div>
      <p className="font-display text-4xl mt-2 caret">Reading your knowledge stores</p>
    </div>
  );
}

function NoKS() {
  return (
    <div className="py-24">
      <div className="label">No knowledge base selected</div>
      <p className="font-display text-5xl mt-3 max-w-2xl leading-tight">
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
