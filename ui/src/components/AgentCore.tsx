// "Agent" tab — chat with the Strands agent on AgentCore Runtime.
//
// Same three-pane shape as the Rough Cut studio:
//   ┌─ Left rail ─┬─ Center ──────────────────┬─ Right rail ─┐
//   │ Question +  │ Latest agent response      │ Live arch    │
//   │ chat thread │ (the hero), or suggestions │ sidebar      │
//   └─────────────┴───────────────────────────┴──────────────┘
// No page scroll; each pane scrolls internally where content overflows.

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { agentEnabled, streamAgentTurn } from "../lib/agent-api";
import { ResponseMarkdown } from "../lib/vref";
import { useStore, setState as setGlobal } from "../lib/store";
import { LiveArchSidebar } from "./LiveArchSidebar";
import { nodeForEvent, downstreamFor, type NodeId } from "./LiveArchDiagram";
import { ArchHandle } from "../App";
import {
  saveEntry,
  updateEntry,
  type AgentHistoryEntry,
  type AgentTurnSnapshot,
} from "../lib/roughcut-history";

type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  elapsedMs?: number;
};

const enabled = agentEnabled();

export function AgentCore() {
  const ks = useStore((s) => s.ks);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<NodeId | null>(null);
  const [nodeHistory, setNodeHistory] = useState<NodeId[]>([]);
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Consume any pending restore the drawer leaves in the global store.
  // Subscribing (vs reading once on mount) covers two paths: cross-tab
  // restore (AgentCore is mounting fresh) AND in-tab restore (AgentCore
  // is already mounted; the store update is what we react to).
  const pendingRestore = useStore((s) => s.pendingRestore);
  useEffect(() => {
    if (pendingRestore && pendingRestore.kind === "agent") {
      setTurns(pendingRestore.turns.map((t) => ({ id: t.id, role: t.role, text: t.text, elapsedMs: t.elapsedMs })));
      setSessionId(pendingRestore.session_id);
      setHistoryEntryId(pendingRestore.id);
      setErr(null);
      setGlobal({ pendingRestore: undefined });
    }
  }, [pendingRestore]);

  if (!enabled) return <NotDeployed />;

  const recordNode = (n: NodeId) => {
    setActiveNode((prev) => {
      if (prev && prev !== n) setNodeHistory((h) => h.includes(prev) ? h : [...h, prev]);
      return n;
    });
  };

  const send = async () => {
    if (!ks || !draft.trim() || busy) return;
    const text = draft.trim();
    setDraft(""); setErr(null);
    const userTurn: Turn = { id: rid(), role: "user", text };
    const aTurn: Turn = { id: rid(), role: "assistant", text: "", streaming: true };
    setTurns((ts) => [...ts, userTurn, aTurn]);
    setBusy(true);
    setActiveNode("runtime");
    setNodeHistory([]);
    const t0 = Date.now();

    let acc = "";
    try {
      for await (const ev of streamAgentTurn({
        knowledge_store_id: ks._id,
        prompt: text,
        session_id: sessionId,
      })) {
        const node = nodeForEvent(ev as { type: string; tool?: string });
        if (node) {
          recordNode(node);
          if (ev.type === "tool_call") {
            const downstream = downstreamFor((ev as { tool?: string }).tool);
            if (downstream) setTimeout(() => recordNode(downstream), 400);
          }
        }
        if (ev.type === "session") {
          if (!sessionId) setSessionId(ev.session_id);
        } else if (ev.type === "text_delta") {
          acc += ev.delta;
          setTurns((ts) => ts.map((t) => t.id === aTurn.id ? { ...t, text: acc } : t));
          responseRef.current?.scrollTo({ top: 1e9 });
        } else if (ev.type === "error") {
          setErr(ev.message);
        } else if (ev.type === "done") {
          setTimeout(() => setActiveNode(null), 1200);
        }
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      const elapsedMs = Date.now() - t0;
      setTurns((ts) => ts.map((t) => t.id === aTurn.id ? { ...t, streaming: false, elapsedMs } : t));
      setBusy(false);

      // Persist this session to history. Snapshots are built from
      // local state we tracked through the loop: userTurn (already in
      // turns), aTurn (id known) with the accumulated text on it (we
      // were updating that into turns as deltas arrived; rather than
      // wait for the async setTurns updater above, we reconstruct the
      // final shape synchronously from `acc` + the previous turns).
      const snapshots: AgentTurnSnapshot[] = [
        ...turns.filter((t) => !t.streaming && t.id !== aTurn.id),
        { id: userTurn.id, role: "user", text: userTurn.text },
        { id: aTurn.id, role: "assistant", text: acc, elapsedMs },
      ];
      const title = userTurn.text;
      if (historyEntryId) {
        updateEntry<AgentHistoryEntry>(historyEntryId, {
          turns: snapshots,
          session_id: sessionId,
        });
      } else {
        const saved = saveEntry<AgentHistoryEntry>({
          kind: "agent",
          title,
          session_id: sessionId,
          ks_id: ks?._id,
          ks_name: ks?.name,
          turns: snapshots,
        });
        setHistoryEntryId(saved.id);
      }
      window.dispatchEvent(new Event("history:updated"));
    }
  };

  const reset = () => {
    setTurns([]);
    setSessionId(undefined);
    setErr(null);
    setHistoryEntryId(null);
  };

  // The center pane shows the most-recent assistant turn (the hero); if no
  // turns yet, it shows suggestions. Older turns are visible in the left
  // rail's chat thread.
  const heroTurn = [...turns].reverse().find((t) => t.role === "assistant") || null;
  const heroQuestion = (() => {
    if (!heroTurn) return null;
    const i = turns.findIndex((t) => t.id === heroTurn.id);
    return i > 0 ? turns[i - 1] : null;
  })();

  // Auto-scroll the chat history to the bottom on new turns.
  useEffect(() => { threadRef.current?.scrollTo({ top: 1e9 }); }, [turns.length]);

  const archOpen = useStore((s) => s.archOpen);

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: archOpen ? "320px 1fr 320px" : "320px 1fr" }}
    >
      {/* LEFT RAIL — question + chat history */}
      <aside className="flex flex-col min-h-0 border-r" style={{ borderColor: "var(--color-rule)" }}>
        {/* § Question */}
        <div className="px-5 pt-5 pb-4 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <div className="flex items-center justify-between">
            <span className="label">§ Question</span>
            <div className="flex items-center gap-3">
              <button
                className="label hover:text-[var(--color-ink)] transition-colors"
                onClick={() => setGlobal({ historyOpen: true })}
                title="history"
              >
                history
              </button>
              {turns.length > 0 && (
                <button
                  className="label hover:text-[var(--color-ink)] transition-colors"
                  onClick={reset}
                  disabled={busy}
                  title="discard this thread and start a new session"
                >
                  + new session
                </button>
              )}
            </div>
          </div>
          <textarea
            className="bg-transparent border w-full p-3 mt-3 outline-none text-sm font-mono rounded-[var(--radius-card)]"
            style={{ borderColor: "var(--color-rule)", minHeight: 96 }}
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask anything about the active knowledge base…  (⌘↩)"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
            disabled={busy}
          />
          <div className="flex items-center justify-between mt-2">
            <div className="label" style={{ color: "var(--color-ink-faint)" }}>
              {busy ? "thinking…" : "⌘↩ to send"}
            </div>
            <button className="btn btn-cue" onClick={send} disabled={busy || !draft.trim() || !ks}>
              {busy ? "..." : "ask →"}
            </button>
          </div>
        </div>

        {/* § Thread — past turns in chronological order */}
        {turns.length > 0 && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="px-5 pt-3 pb-2">
              <span className="label">§ Thread · {turns.filter((t) => t.role === "user").length}</span>
            </div>
            <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto px-5 pb-4 space-y-3">
              {turns.map((t) => {
                const isLatestAssistant = heroTurn && t.id === heroTurn.id;
                return (
                  <div key={t.id} className="text-xs leading-relaxed">
                    {t.role === "user" ? (
                      <div>
                        <div className="label text-[10px]" style={{ color: "var(--color-ink-faint)" }}>You</div>
                        <p className="mt-0.5 font-mono" style={{ color: "var(--color-ink)" }}>{t.text}</p>
                      </div>
                    ) : (
                      <div
                        className={`p-2 rounded-[8px] ${isLatestAssistant ? "border" : ""}`}
                        style={isLatestAssistant ? { borderColor: "var(--color-rule)", background: "var(--color-surface)" } : undefined}
                      >
                        <div className="flex items-baseline justify-between">
                          <div className="label text-[10px]" style={{ color: "var(--color-cue)" }}>Agent</div>
                          {t.elapsedMs && (
                            <div className="font-mono text-[9px]" style={{ color: "var(--color-ink-faint)" }}>
                              {(t.elapsedMs / 1000).toFixed(1)}s
                            </div>
                          )}
                        </div>
                        <p className="mt-0.5 truncate" style={{ color: "var(--color-ink-soft)" }}>
                          {t.streaming ? "…" : (t.text.slice(0, 120) + (t.text.length > 120 ? "…" : ""))}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>

      {/* CENTER — the latest agent response, rendered large. */}
      <section className="flex flex-col min-h-0 overflow-hidden">
        {!turns.length && (
          <div className="flex-1 min-h-0 overflow-y-auto px-10 py-12">
            <Suggestions onPick={setDraft} />
          </div>
        )}

        {turns.length > 0 && (
          <>
            <div className="px-8 pt-5 pb-3 border-b flex items-baseline justify-between" style={{ borderColor: "var(--color-rule)" }}>
              <div>
                <div className="label">§ Response</div>
                {heroQuestion && (
                  <p className="mt-1 text-lg font-display tracking-tight truncate max-w-[60ch]">
                    "{heroQuestion.text}"
                  </p>
                )}
              </div>
              {heroTurn?.elapsedMs && !heroTurn.streaming && (
                <div className="font-mono text-sm" style={{ color: "var(--color-ink-soft)" }}>
                  {(heroTurn.elapsedMs / 1000).toFixed(1)}s
                </div>
              )}
            </div>
            <div ref={responseRef} className="flex-1 min-h-0 overflow-y-auto px-8 py-6">
              {heroTurn ? (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
                  {heroTurn.text ? (
                    <div className={heroTurn.streaming ? "caret" : ""}>
                      <ResponseMarkdown text={heroTurn.text} ksId={ks?._id} />
                    </div>
                  ) : (
                    <p className="caret font-display text-2xl" style={{ color: "var(--color-ink-soft)" }}>
                      Agent reasoning…
                    </p>
                  )}
                </motion.div>
              ) : (
                <p className="text-sm" style={{ color: "var(--color-ink-soft)" }}>
                  Send a question on the left to begin.
                </p>
              )}
              {err && (
                <pre className="font-mono text-xs mt-6 p-3 whitespace-pre-wrap rounded-[var(--radius-card)]" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>
                  {err}
                </pre>
              )}
            </div>
          </>
        )}
      </section>

      {/* RIGHT RAIL — live arch sidebar (same component as Rough Cut).
          Hidden by default; the <ArchHandle/> on the viewport's right edge
          slides this in/out. */}
      {archOpen && (
        <aside className="flex flex-col min-h-0 border-l" style={{ borderColor: "var(--color-rule)" }}>
          <LiveArchSidebar
            activeNode={activeNode}
            history={nodeHistory}
            sessionId={sessionId}
          />
        </aside>
      )}
      <ArchHandle />
    </div>
  );
}

function rid() { return Math.random().toString(36).slice(2, 10); }

function Suggestions({ onPick }: { onPick: (s: string) => void }) {
  const samples = [
    "Summarize what's in this knowledge base in two sentences.",
    "Find clips that look like an action set-piece.",
    "Pick three clips that could open a 30-second highlight reel.",
    "What's the most kinetic moment in this corpus?",
  ];
  return (
    <div className="max-w-2xl">
      <div className="label">Try</div>
      <ul className="mt-3 space-y-3">
        {samples.map((s) => (
          <li key={s}>
            <button
              className="font-display text-2xl text-left leading-snug hover:text-[var(--color-ink)] transition-colors"
              style={{ color: "var(--color-ink-soft)" }}
              onClick={() => onPick(s)}
            >
              "{s}"
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm mt-10 max-w-md" style={{ color: "var(--color-ink-faint)" }}>
        Tiered agent on AgentCore Runtime — tools route from the DDB knowledge
        cache (<span className="font-mono">get_kb_overview</span>,{" "}
        <span className="font-mono">list_kb_assets</span>) through S3 Vectors{" "}
        (<span className="font-mono">vector_search</span>,{" "}
        <span className="font-mono">find_entity_by_image</span>) to Bedrock
        Pegasus (<span className="font-mono">pegasus_analyze</span>) for
        on-demand take-notes. Every model is invoked via Bedrock; no
        TwelveLabs SaaS dependency. Open the right rail (▣) to watch each
        lane light up as the agent calls it.
      </p>
    </div>
  );
}

function NotDeployed() {
  return (
    <div className="h-full overflow-y-auto px-8 py-12 max-w-3xl mx-auto">
      <div className="label">AgentCore stack not configured</div>
      <p className="font-display text-3xl mt-3 leading-tight">
        The Strands agent isn't wired yet.
      </p>
      <p className="mt-6 text-sm" style={{ color: "var(--color-ink-soft)" }}>
        From the project root: <span className="font-mono">cd infra && terraform apply</span>,
        push the agent container with <span className="font-mono">bash build-agent.sh</span>, then re-apply
        with <span className="font-mono">-var agent_image_tag=v&lt;ts&gt;</span>.
      </p>
    </div>
  );
}
