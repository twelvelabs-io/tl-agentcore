// "Agent" tab — chat with the Strands agent on AgentCore Runtime.
// Four tools at the agent's disposal: ask_jockey, lookup_rights,
// list_audiences, lookup_audience. The right rail surfaces the live
// architecture diagram so a viewer can watch each tool fire as the agent
// reasons.

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { agentEnabled, streamAgentTurn } from "../lib/agent-api";
import { ResponseMarkdown } from "../lib/vref";
import { useStore } from "../lib/store";
import { LiveArchDiagram, nodeForEvent, downstreamFor, type NodeId } from "./LiveArchDiagram";

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
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!enabled) return <NotDeployed />;

  const send = async () => {
    if (!ks || !draft.trim() || busy) return;
    const text = draft.trim();
    setDraft(""); setErr(null);
    const userTurn: Turn = { id: rid(), role: "user", text };
    const aTurn: Turn = { id: rid(), role: "assistant", text: "", streaming: true };
    setTurns((ts) => [...ts, userTurn, aTurn]);
    setBusy(true);
    setActiveNode("chat_lambda");
    setNodeHistory([]);
    const recordNode = (n: NodeId) => {
      setActiveNode((prev) => {
        if (prev && prev !== n) setNodeHistory((h) => h.includes(prev) ? h : [...h, prev]);
        return n;
      });
    };
    const t0 = Date.now();

    // The Agent tab demonstrates Jockey-level orchestration. Marengo +
    // Pegasus + cache primitives are reserved for the Studio tab; the
    // Newsroom Vault tools (entity collections, POIs, dossiers, embed
    // export) ARE fair game here — they're how a producer drives the
    // archive workflow from chat.
    //
    // Routing rules are spelled out explicitly because the SYSTEM_PROMPT
    // tier-list frontloads ask_jockey for KB questions, which causes the
    // model to mis-route registry questions ("what POI collections do we
    // have?") into ask_jockey, which then returns "no POI metadata found"
    // because Jockey reasons over video content, not the registry.
    const guardedPrompt =
      "ROUTING (apply BEFORE ask_jockey):\n" +
      "- POI / collection / entity / 'who appears' / 'persons of interest' → list_entity_collections, list_pois, lookup_poi, find_appearances, entities_in_asset.\n" +
      "- 'find every clip of [person]' → list_entity_collections → list_pois → entity_search OR find_appearances.\n" +
      "- 'summarize each appearance' / bulk Pegasus → open_dossier → close_dossier.\n" +
      "- 'follow up' / 'and then what about' (with prior session_id) → ask_followup.\n" +
      "- Embeddings export → export_embeddings, embed_text.\n" +
      "- Generic Q&A about video CONTENT (what happens in the videos, what's said, dramatic arc) → ask_jockey.\n" +
      "- Rights / audience questions → lookup_rights / list_audiences / lookup_audience as ancillary.\n\n" +
      "FORBIDDEN this turn (Studio-only): marengo_search, pegasus_analyze, list_tl_indexes, get_kb_overview, list_kb_assets, lookup_asset_profile.\n\n" +
      "User question:\n" + text;

    try {
      let acc = "";
      for await (const ev of streamAgentTurn({
        mode: "agentcore",
        knowledge_store_id: ks._id,
        prompt: guardedPrompt,
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
        } else if (ev.type === "error") {
          setErr(ev.message);
        } else if (ev.type === "done") {
          setTimeout(() => setActiveNode(null), 1200);
        }
        scrollRef.current?.scrollTo({ top: 1e9 });
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      const elapsedMs = Date.now() - t0;
      setTurns((ts) => ts.map((t) => t.id === aTurn.id ? { ...t, streaming: false, elapsedMs } : t));
      setBusy(false);
    }
  };

  const reset = () => { setTurns([]); setSessionId(undefined); setErr(null); };

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-12">
      <section>
        <div className="label">§ I · Question</div>
        <div className="rule mt-3 mb-6" />

        <div className="border-b pb-4" style={{ borderColor: "var(--color-rule)" }}>
          <textarea
            className="editorial-input"
            rows={2}
            placeholder="Ask anything about the active knowledge base. Try: 'find a Brad Pitt drama and check its EMEA broadcast clearance'."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          />
          <div className="flex items-center justify-between mt-3">
            <div className="label" style={{ color: "var(--color-ink-faint)" }}>
              ⌘↩ to send · sigv4 → InvokeAgentRuntime · Strands · Sonnet 4.6 · cache-first tool palette
            </div>
            <div className="flex gap-2">
              <button className="btn" onClick={reset} disabled={busy || !turns.length}>new session</button>
              <button className="btn btn-cue" onClick={send} disabled={busy || !draft.trim() || !ks}>
                {busy ? "thinking…" : "ask →"}
              </button>
            </div>
          </div>
        </div>

        <div ref={scrollRef} className="mt-12 space-y-12 max-h-[60vh] overflow-y-auto pr-2">
          {turns.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
              {t.role === "user" ? (
                <div>
                  <div className="label">Asked</div>
                  <p className="font-display text-3xl leading-snug mt-2 max-w-2xl">"{t.text}"</p>
                </div>
              ) : (
                <div>
                  <div className="flex items-baseline gap-3">
                    <div className="label" style={{ color: "var(--color-cue)" }}>Strands · AgentCore</div>
                    {t.elapsedMs && (
                      <div className="label" style={{ color: "var(--color-ink-faint)" }}>
                        {(t.elapsedMs / 1000).toFixed(1)}s
                      </div>
                    )}
                  </div>
                  <div className={`mt-2 ${t.streaming ? "caret" : ""}`}>
                    {t.text ? <ResponseMarkdown text={t.text} ksId={ks?._id} /> : (t.streaming ? null : <p style={{ color: "var(--color-ink-soft)" }}>(no text)</p>)}
                  </div>
                </div>
              )}
            </motion.div>
          ))}

          {!turns.length && <Suggestions onPick={setDraft} />}
          {err && <pre className="font-mono text-xs p-3" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)", whiteSpace: "pre-wrap" }}>{err}</pre>}
        </div>
      </section>

      {/* Right rail — what the agent has at its disposal */}
      <aside className="lg:border-l lg:pl-8" style={{ borderColor: "var(--color-rule)" }}>
        <div className="label">§ II · Tools</div>
        <div className="rule mt-3 mb-4" />
        <ToolRow name="ask_jockey"      hint="video reasoning over the active KB" />
        <ToolRow name="lookup_rights"   hint="DDB · licensing window + talent" />
        <ToolRow name="list_audiences"  hint="DDB · catalog of audience segments" />
        <ToolRow name="lookup_audience" hint="DDB · genre + daypart affinity" />

        <div className="label mt-12">§ III · Stack</div>
        <div className="rule mt-3 mb-4" />
        <Field label="Orchestrator" mono>Strands · Sonnet 4.6</Field>
        <div className="mt-3"><Field label="Host" mono>AgentCore Runtime · arm64</Field></div>
        <div className="mt-3"><Field label="Tool catalog" mono>AgentCore Gateway · MCP</Field></div>
        <div className="mt-3"><Field label="Identity" mono>Cognito JWT through-flow</Field></div>

        <div className="label mt-12">§ IV · Session</div>
        <div className="rule mt-3 mb-4" />
        <Field label="Knowledge store" mono>{ks?._id || "—"}</Field>
        <div className="mt-4"><Field label="Runtime session" mono>{sessionId || "(new on first turn)"}</Field></div>
      </aside>

      <section className="lg:col-span-2 mt-16 pt-12 border-t" style={{ borderColor: "var(--color-rule)" }}>
        <div className="label">§ V · Live architecture</div>
        <p className="font-display text-3xl lg:text-4xl mt-2 max-w-3xl leading-tight">
          The Cognito JWT flows from <span style={{ color: "var(--color-cue)" }}>browser</span> all the way to the
          MCP Gateway. Nodes light up as the agent reasons.
        </p>
        <p className="text-sm mt-3 max-w-2xl" style={{ color: "var(--color-ink-soft)" }}>
          Single CloudFront origin, single WebSocket, single user identity end-to-end.
          The agent calls tools through AgentCore Gateway-as-MCP — typed tool catalog,
          bearer-JWT auth, OTEL traces.
        </p>
        <div className="rule mt-6 mb-10" />
        <LiveArchDiagram activeNode={activeNode} history={nodeHistory} hideStudioPath />
      </section>
    </div>
  );
}

function rid() { return Math.random().toString(36).slice(2, 10); }

function Suggestions({ onPick }: { onPick: (s: string) => void }) {
  const samples = [
    "Find a Brad Pitt drama and check its EMEA broadcast clearance.",
    "Which clips would over-index for Men 35-54?",
    "Pick one comedy and one thriller, then check rights for both.",
    "Summarize what's in this knowledge base in two sentences.",
  ];
  return (
    <div className="py-12">
      <div className="label">Try</div>
      <ul className="mt-2 space-y-2 max-w-xl">
        {samples.map((s) => (
          <li key={s}>
            <button className="font-display text-2xl text-left hover:text-[var(--color-cue)]" onClick={() => onPick(s)}>
              "{s}"
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolRow({ name, hint }: { name: string; hint: string }) {
  return (
    <div className="mb-3">
      <div className="font-mono text-sm" style={{ color: "var(--color-cue)" }}>{name}</div>
      <div className="text-xs mt-0.5" style={{ color: "var(--color-ink-soft)" }}>{hint}</div>
    </div>
  );
}

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="label" style={{ color: "var(--color-ink-faint)" }}>{label}</div>
      <div className={`mt-1 ${mono ? "font-mono text-xs break-all" : "text-sm"}`}>{children}</div>
    </div>
  );
}

function NotDeployed() {
  return (
    <div className="py-24">
      <div className="label">AgentCore stack not configured</div>
      <p className="font-display text-5xl mt-3 max-w-2xl leading-tight">
        The Strands agent isn't wired yet.
      </p>
      <p className="mt-6 text-sm max-w-2xl" style={{ color: "var(--color-ink-soft)" }}>
        From the project root: <span className="font-mono">cd infra-agentcore && terraform apply</span>,
        push the agent container with <span className="font-mono">bash build-agent.sh</span>, then re-apply{" "}
        <span className="font-mono">infra/</span> with{" "}
        <span className="font-mono">-var agentcore_runtime_arn=&lt;…&gt;</span>.
      </p>
    </div>
  );
}
