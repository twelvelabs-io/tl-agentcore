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
import { agentEnabled, errorLabel, streamAgentTurn } from "../lib/agent-api";
import { fetchScores, type JudgeRow } from "../lib/api";
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
  // Human-readable "doing X now" lines from response.activity frames.
  // The agent emits one per tool call (narrated by activity_narrator.py)
  // and one for each pipeline / preseed / rewoo stage. Rendered as a dim
  // mono strip under the § Response header so producers can see what the
  // agent is up to without reading the raw function_call JSON.
  activity?: string[];
  // Set from response.completed.tool_path — carries the pipeline / tool
  // transport the agent actually ran this turn through (e.g. "react",
  // "rewoo", "in-process", "mcp-gateway"). Rendered as a small label
  // next to the elapsed time in the response header.
  toolPath?: string;
  // Online judge rows (coherence + reference_validity) pulled from the
  // /scores/{response_id} endpoint. Fetched a short delay after
  // response.completed since judges run fire-and-forget. Rendered as a
  // small panel under the trace strip; empty array means "no judges
  // yet" (which may be legitimate if sampling or a judge failure).
  responseId?: string;
  judges?: JudgeRow[];
};

const enabled = agentEnabled();

export function AgentCore() {
  const ks = useStore((s) => s.ks);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);
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
    setDraft(""); setErr(null); setErrCode(null);
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
        // Sniff tool name from a function_call item added/done so the arch
        // diagram can light the right lane. Other item types just show
        // "runtime" via nodeForEvent.
        let toolName: string | undefined;
        if ((ev.type === "response.output_item.added" || ev.type === "response.output_item.done")
            && ev.item.type === "function_call") {
          toolName = ev.item.name;
        }
        const node = nodeForEvent({ type: ev.type, tool: toolName });
        if (node) {
          recordNode(node);
          if (ev.type === "response.output_item.added" && toolName) {
            const downstream = downstreamFor(toolName);
            if (downstream) setTimeout(() => recordNode(downstream), 400);
          }
        }

        if (ev.type === "response.created") {
          if (!sessionId) setSessionId(ev.response.id);
          // Stash the response_id on the current turn so the scores
          // fetch (fired after completed) can hit the right row.
          const rid = ev.response.id;
          setTurns((ts) => ts.map((t) =>
            t.id === aTurn.id ? { ...t, responseId: rid } : t
          ));
        } else if (ev.type === "response.output_text.delta") {
          acc += ev.delta;
          setTurns((ts) => ts.map((t) => t.id === aTurn.id ? { ...t, text: acc } : t));
          responseRef.current?.scrollTo({ top: 1e9 });
        } else if (ev.type === "response.activity") {
          const line = ev.text;
          setTurns((ts) => ts.map((t) =>
            t.id === aTurn.id
              ? { ...t, activity: [...(t.activity || []), line] }
              : t
          ));
        } else if (ev.type === "response.output_item.done"
                   && ev.item.type === "function_call"
                   && ev.item.error_code) {
          // Surface tool-level failures in the activity trace. The
          // narrator fired a "Searching the KB for..." line at
          // tool_begin; this appends the outcome so the producer sees
          // which tool failed and the taxonomic bucket.
          const label = errorLabel(ev.item.error_code);
          const line = `⚠ ${ev.item.name} failed — ${label}`;
          setTurns((ts) => ts.map((t) =>
            t.id === aTurn.id
              ? { ...t, activity: [...(t.activity || []), line] }
              : t
          ));
        } else if (ev.type === "response.failed") {
          setErr(ev.response.error.message);
          setErrCode(ev.response.error.code || null);
        } else if (ev.type === "response.completed") {
          const tp = ev.response.tool_path;
          if (tp) {
            setTurns((ts) => ts.map((t) =>
              t.id === aTurn.id ? { ...t, toolPath: tp } : t
            ));
          }
          // Judges run fire-and-forget on the runtime side; give them a
          // couple seconds to land in DDB before fetching. A single
          // fetch is enough — Sonnet latency is well under 2s and the
          // runtime awaits the dispatch (not the result) synchronously.
          const rid = ev.response.id;
          setTimeout(async () => {
            try {
              const { judges } = await fetchScores(rid);
              setTurns((ts) => ts.map((t) =>
                t.id === aTurn.id ? { ...t, judges } : t
              ));
            } catch {
              // Scores are an observability nice-to-have — a failure
              // here never breaks the chat turn.
            }
          }, 2000);
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
                <div className="flex items-baseline gap-2">
                  {heroTurn.toolPath && (
                    <span
                      className="px-1.5 py-0.5 rounded-full font-mono text-[9px] uppercase tracking-wider"
                      style={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-rule)",
                        color: "var(--color-ink-faint)",
                      }}
                      title={`pipeline / transport: ${heroTurn.toolPath}`}
                    >
                      {heroTurn.toolPath}
                    </span>
                  )}
                  <span className="font-mono text-sm" style={{ color: "var(--color-ink-soft)" }}>
                    {(heroTurn.elapsedMs / 1000).toFixed(1)}s
                  </span>
                </div>
              )}
            </div>
            <div ref={responseRef} className="flex-1 min-h-0 overflow-y-auto px-8 py-6">
              {heroTurn?.activity && heroTurn.activity.length > 0 && (
                <ActivityStrip lines={heroTurn.activity} live={!!heroTurn.streaming} />
              )}
              {heroTurn && heroTurn.judges !== undefined && !heroTurn.streaming && (
                <JudgeStrip judges={heroTurn.judges} />
              )}
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
                <div className="mt-6">
                  {errCode && (
                    <div className="inline-block mb-2 px-2 py-0.5 rounded-full font-mono text-[10px] uppercase tracking-wider" style={{
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-rule)",
                      color: "var(--color-status-failed)",
                    }}>
                      {errorLabel(errCode)}
                    </div>
                  )}
                  <pre className="font-mono text-xs p-3 whitespace-pre-wrap rounded-[var(--radius-card)]" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>
                    {err}
                  </pre>
                </div>
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

// Dim mono strip rendered under the § Response header for the active
// turn, showing the agent's own human-readable narration (one line per
// tool call plus pipeline / preseed / rewoo stage lines). While the
// turn is streaming, shows a collapsed tail; once completed, becomes
// a disclosure the producer can expand to see the full trace.
function ActivityStrip({ lines, live }: { lines: string[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tail = live ? lines.slice(-4) : lines.slice(-1);
  const hidden = lines.length - tail.length;
  const show = open ? lines : tail;
  return (
    <div
      className="mb-4 rounded-[var(--radius-card)] px-3 py-2 border font-mono"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-surface)",
        color: "var(--color-ink-faint)",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="label" style={{ color: "var(--color-ink-faint)" }}>
          § Trace
        </span>
        {!live && hidden > 0 && (
          <button
            className="label hover:text-[var(--color-ink)] transition-colors"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "collapse" : `+${hidden} more`}
          </button>
        )}
      </div>
      <ul className="mt-1 space-y-0.5">
        {show.map((line, i) => (
          <li key={`${i}-${line.slice(0, 24)}`} className="truncate">
            {live && i === show.length - 1 ? "▸ " : "· "}
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Shown under the trace strip once the fire-and-forget judges have
// landed. Empty judges[] means the fetch succeeded but no rows exist
// yet (sampling miss or a sub-2s judge write) — surface that explicitly
// so the producer knows the UI isn't broken.
function JudgeStrip({ judges }: { judges: JudgeRow[] }) {
  if (judges.length === 0) {
    return (
      <div
        className="mb-4 rounded-[var(--radius-card)] px-3 py-2 border font-mono"
        style={{
          borderColor: "var(--color-rule)",
          background: "var(--color-surface)",
          color: "var(--color-ink-faint)",
          fontSize: 11,
        }}
      >
        <span className="label" style={{ color: "var(--color-ink-faint)" }}>§ Judges</span>
        <span className="ml-2">no scores yet (sampled out or judge still writing)</span>
      </div>
    );
  }
  return (
    <div
      className="mb-4 rounded-[var(--radius-card)] px-3 py-2 border"
      style={{
        borderColor: "var(--color-rule)",
        background: "var(--color-surface)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="label" style={{ color: "var(--color-ink-faint)" }}>§ Judges</span>
        <span className="label font-mono" style={{ color: "var(--color-ink-faint)" }}>
          {judges.length}
        </span>
      </div>
      <ul className="mt-1 space-y-1.5 text-[11px]" style={{ color: "var(--color-ink-soft)" }}>
        {judges.map((j) => (
          <li key={j.judge_name} className="flex items-start gap-2">
            <JudgeScore score={j.score} />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--color-ink-faint)" }}>
                {j.judge_name.replace(/_/g, " ")}
                {j.latency_ms != null && ` · ${j.latency_ms}ms`}
              </div>
              {j.justification && (
                <div className="mt-0.5" style={{ color: "var(--color-ink)" }}>
                  {j.justification}
                </div>
              )}
              {j.error && (
                <div className="mt-0.5 font-mono" style={{ color: "var(--color-status-failed)" }}>
                  error: {j.error}
                </div>
              )}
              {j.missing_asset_ids && j.missing_asset_ids.length > 0 && (
                <div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--color-status-failed)" }}>
                  missing: {j.missing_asset_ids.length} asset{j.missing_asset_ids.length === 1 ? "" : "s"}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JudgeScore({ score }: { score?: number | null }) {
  const display = score == null ? "—" : String(score);
  const color = score == null
    ? "var(--color-ink-faint)"
    : score >= 4
      ? "var(--color-cue)"
      : score >= 3
        ? "var(--color-ink-soft)"
        : "var(--color-status-failed)";
  return (
    <div
      className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-mono text-[11px]"
      style={{
        background: "var(--color-bg)",
        border: `1px solid ${color}`,
        color,
      }}
      title={score == null ? "no score" : `${score}/5`}
    >
      {display}
    </div>
  );
}

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
        <span className="font-mono">find_by_image</span>) to Bedrock
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
