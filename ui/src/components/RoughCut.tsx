// "Rough Cut" — the headline workflow.
//
// User pastes a script (free-form prose, treatment, scene outline; the
// agent parses any of them). The AgentCore Strands agent reads the script
// plus the active KB's contents, assembles a scene-by-scene plan with clip
// references and timecodes, and the UI renders a producer-readable
// timeline with EDL export and (Phase 2) a MediaConvert preview render.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { streamAgentTurn } from "../lib/agent-api";
import { useStore } from "../lib/store";
import { getAsset, getStitch, startStitch, type Asset, type Channel, type StitchJob } from "../lib/api";
import { ChannelPlayer } from "./ChannelPlayer";
import { SmartClipThumb } from "../lib/clip-thumb";
import { EntityChips } from "./EntityChips";
import { LiveArchSidebar } from "./LiveArchSidebar";
import { nodeForEvent, downstreamFor, type NodeId } from "./LiveArchDiagram";
import { setState as setGlobal } from "../lib/store";
import { ResponseMarkdown } from "../lib/vref";
import { ArchHandle } from "../App";
import {
  fmtDuration,
  generateEDL,
  parseTime,
  totalDuration,
  type RoughCutPlan,
} from "../lib/edl";
import {
  loadHistory,
  saveEntry,
  updateEntry,
  deleteEntry,
  relativeTime,
  type RoughCutHistoryEntry,
  type ChatMessage,
} from "../lib/roughcut-history";

// localStorage key remembering which rough-cut history entry was last
// active. A page refresh reads this on mount and silently restores the
// matching entry — producers don't lose their place to a stray ⌘R.
const LS_LAST_ROUGHCUT_ENTRY = "tl-agentcore.lastRoughCutEntryId";

const DEFAULT_FPS_OPTIONS = [
  { value: 24,    label: "24 fps · cinema (DCP)" },
  { value: 23.976, label: "23.976 fps · digital cinema" },
  { value: 25,    label: "25 fps · PAL" },
  { value: 29.97, label: "29.97 fps · NTSC NDF" },
  { value: 30,    label: "30 fps" },
];

// Generic enough to work against any KB — the agent picks whatever the
// indexed footage offers and maps it to these three acts. (Earlier versions
// were specific to a desert/dailies KB; that didn't survive switching to
// the Movie Trailers KB, so the sample is now mood-based, not content-based.)
// Canned brief templates the producer can drop into the textarea — one per
// cut type the agent recognizes (sizzle / narrative / montage / mood /
// highlight). Each starts with the cut-type label so the agent's
// classifier locks onto the right ruleset (clip durations, pacing,
// adjacency rules) — see SYSTEM_PROMPT step 2 in agent.py.
type CutType = "sizzle" | "narrative" | "montage" | "mood" | "highlight" | "rough_cut";

const BRIEF_TEMPLATES: Record<CutType, { label: string; tagline: string; brief: string }> = {
  sizzle: {
    label: "Sizzle reel",
    tagline: "30–60 s · kinetic · max variety",
    brief: `Build me a 45-second sizzle reel from the most exciting moments in this collection. Lean kinetic — fast cuts, high energy, dialogue only when it lands hard. Cycle through the strongest visual moments, never two from the same source back-to-back. End on a triumphant or iconic beat that leaves the viewer wanting more.`,
  },
  narrative: {
    label: "Narrative trailer",
    tagline: "60–120 s · three-act arc · tension → release",
    brief: `Cut me a 90-second narrative trailer with a clear emotional arc.

Act 1 — SETUP. Establish the world and a protagonist. Wide context shots intercut with intimate close-ups. Suggest something is about to happen.

Act 2 — CONFLICT. Things escalate. Kinetic, charged, layered. The protagonist faces something.

Act 3 — RESOLUTION. The turn — an iconic line or a single quiet beat that lands the whole story. End on something that lingers.`,
  },
  montage: {
    label: "Montage",
    tagline: "45 s · rapid cuts · one theme",
    brief: `Build me a 45-second montage on a single theme — pick a recurring motion, mood, or visual signature that runs through this collection and string the strongest examples together. Target 45 seconds total. Rapid pacing with rapid cuts; per-clip duration should fall between 2 and 4 seconds. No narrative arc required — treat it like a music-video opener, all rhythm.`,
  },
  mood: {
    label: "Mood reel / B-roll",
    tagline: "120 s · atmospheric · slower pacing",
    brief: `Compile a 120-second mood reel — atmospheric, contemplative, no rush. Target 120 seconds total. Lean on landscape shots, held faces, ambient moments. Per-clip duration runs slower than other cut types — 8 to 12 seconds each. Similar emotional register throughout. The goal is a vibe, not a story — something an editor could lay under voiceover or score.`,
  },
  highlight: {
    label: "Highlight reel",
    tagline: "60–180 s · per-event · best moments",
    brief: `Pull the best individual moments from this collection into a highlight reel. Each scene should be one complete event — don't chop within a beat. Order them so the cut builds: solid early plays leading into the most memorable ones. Aim for 90 seconds.`,
  },
  rough_cut: {
    label: "Rough cut · doc/film",
    tagline: "3 min · full assembly · story arc",
    brief: `Assemble a full rough cut — this is the editor's first-pass story assembly for a documentary or short film, NOT a trailer or sizzle. Target 3 minutes. Walk the story from cold open through coda:

— Cold open: a single grounded character or setting beat that pulls the viewer in. ~20 s.
— Setup: establish the world, the people, the stakes. Wide and intimate, intercut. Bring in interview / voice when it lands a specific fact or feeling.
— Development: introduce friction, decisions, change. Pace varies — let breath shots sit, let confrontations escalate.
— Climax: the cut's hardest emotional or factual punch.
— Coda: a held image or quiet line that resolves the arc.

Use 10–25-second beats — give each scene room to breathe. Mix interview, b-roll, atmospheric, archival as the corpus offers. Reusing a source asset across non-consecutive scenes is fine and expected — different interview takes from the same subject, multiple b-roll angles of the same location, etc. The ONLY hard adjacency rule is no two consecutive scenes from the same asset.`,
  },
};

const DEFAULT_CUT_TYPE: CutType = "sizzle";
const SAMPLE_SCRIPT = BRIEF_TEMPLATES[DEFAULT_CUT_TYPE].brief;

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    scenes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          scene_id: { type: "string" },
          scene_name: { type: "string" },
          scene_description: { type: "string" },
          clips: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                video_reference: { type: "string", description: "TwelveLabs asset_id (24-char hex)" },
                start_time: { type: "string", description: "HH:MM:SS within the source clip" },
                end_time: { type: "string", description: "HH:MM:SS within the source clip" },
                role: { type: "string", description: "establishing | wide | medium | close-up | insert | cutaway | b-roll" },
                take_note: { type: "string", description: "why this take/range was chosen" },
                alternatives: {
                  type: "array",
                  description: "2-4 ranked alternates from the same vector_search response, ordered by ascending rank.",
                  items: {
                    type: "object",
                    properties: {
                      video_reference: { type: "string", description: "TwelveLabs asset_id or video_id of the alternate" },
                      start_time: { type: "string" },
                      end_time: { type: "string" },
                      rank: { type: "integer", description: "Marengo rank (1 = best) from the same query as the primary" },
                      why_alt: { type: "string", description: "one phrase, what makes this a defensible swap" },
                    },
                    required: ["video_reference", "start_time", "end_time"],
                  },
                },
              },
              required: ["video_reference", "start_time", "end_time"],
            },
          },
        },
        required: ["scene_id", "scene_name", "clips"],
      },
    },
    total_estimated_duration: { type: "string" },
    notes: { type: "string" },
  },
  required: ["title", "scenes"],
};

// User-message wrapper appended per turn. Restates the retrieval contract
// for the agent so orchestration stays deterministic across runs and across
// UI surfaces.
const AGENT_INSTRUCTIONS = `TASK: compose an EDL from the brief below and the active knowledge_store_id supplied as \`[ks: ks_xxx]\` in this message. One retrieval primitive: \`vector_search\`. Emit one call per beat in parallel, then write the EDL.

PROCEDURE
  Step 1. Parse the brief into N beat phrases, one per intended scene, in narrative order. Write each phrase as a retrieval query: a concrete sensory verb, the dominant subject, and one tonal modifier. Strip articles and stage directions.
  Step 2. In a single model turn, emit N vector_search calls in parallel. Each call: query_text = the beat phrase, knowledge_store_id = the KS from \`[ks: ks_xxx]\`, k = 5.
  Step 3. From every response, take rank 1 as the primary clip and ranks 2..k as alternates on the same clip object. Do not redistribute ranks across beats.
  Step 4. Run the adjacency check: if two consecutive primaries look the same in framing or subject, swap one of them for its rank 2. Assign role based on where the clip sits in the cut (opening leans on establishing or wide; middle alternates medium and close-up; closing leans on hero or held). Take_note is one sentence naming what the rank-1 clip visibly shows for the beat - subject + action + framing. Not a justification of the rank.
  Step 5. Emit the EDL.

\`pegasus_analyze\` is optional: invoke only if the brief explicitly asks for description of a specific clip moment that the rank ordering cannot answer.

SCHEMA

<plan>
{
  "title": "string",
  "scenes": [{
    "scene_id": "01",
    "scene_name": "string",
    "scene_description": "optional",
    "clips": [{
      "video_reference": "<24-hex asset_id from vector_search>",
      "start_time": "HH:MM:SS",
      "end_time":   "HH:MM:SS",
      "role": "establishing|wide|medium|close-up|insert|cutaway|b-roll|hero",
      "take_note": "why this clip fits the beat",
      "alternatives": [
        {
          "video_reference": "<24-hex asset_id from same vector_search>",
          "start_time": "HH:MM:SS",
          "end_time":   "HH:MM:SS",
          "rank": 2,
          "why_alt": "one phrase, what makes this a defensible swap"
        }
        /* 2-4 entries, ranks 2..k from the SAME vector_search response,
           ordered by ascending rank. Do not mix alternates across beats. */
      ]
    }]
  }],
  "total_estimated_duration": "MM:SS",
  "notes": "any caveats (low confidence beats, empty index, etc.)"
}
</plan>

REPLY FORMAT
Exactly two parts, in this order:
  (a) one or two sentences of plain commentary describing how the brief was decomposed and how strong the top hits look,
  (b) the JSON above. Strict JSON: no trailing commas, no comments, no markdown fences, no prose after the JSON.

CONSTRAINTS
  - video_reference comes verbatim from a vector_search response. No filenames, no synthesized ids.
  - Per-clip duration between 3 and 30 seconds. Per-scene clip count between 3 and 5. Full cut between 30 seconds and 4 minutes.
  - Time fields are HH:MM:SS with three zero-padded components. No SMPTE frame suffix.

EMPTY INDEX
If vector_search returns \`clips: []\` for every beat, do NOT emit a plan. Reply in plain prose that the embedding index has not been populated for this knowledge_store_id and direct the producer to run \`scripts/ingest_vectors.py <ks_id>\`.`;

// Sanity-check + repair a plan returned by the agent. The agent — even with
// the prompt rules — sometimes emits SMPTE timecode (HH:MM:SS:FF), uses
// filenames instead of asset_ids, or sets source_end hours past the clip.
// Any of those breaks the player. We repair in place.
const ASSET_ID_RE = /^[0-9a-f]{24}$/i;
function secsToHHMMSS(s: number): string {
  const total = Math.max(0, Math.round(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(ss)}`;
}
function sanitizePlan(plan: RoughCutPlan): RoughCutPlan {
  return {
    ...plan,
    scenes: plan.scenes
      .map((sc) => {
        const clips = (sc.clips || [])
          .filter((c) => ASSET_ID_RE.test((c.video_reference || "").trim()))
          .map((c) => {
            const start = parseTime(c.start_time);
            let end = parseTime(c.end_time);
            // Clamp slice to 1-30s; if invalid, default to 8s window.
            if (!isFinite(start) || !isFinite(end) || end <= start || end - start > 30) {
              end = start + 8;
            }
            return {
              ...c,
              start_time: secsToHHMMSS(start),
              end_time:   secsToHHMMSS(end),
            };
          });
        return { ...sc, clips };
      })
      .filter((sc) => sc.clips.length > 0),
  };
}

function extractPlan(text: string): RoughCutPlan | null {
  const tagged = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const candidates: string[] = [];
  if (tagged) candidates.push(tagged[1]);
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) candidates.push(m[1]);
  // Bare top-level {...} containing "scenes":
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          const slice = text.slice(start, i + 1);
          if (/"scenes"\s*:/.test(slice)) candidates.push(slice);
          break;
        }
      }
    }
  }
  for (const c of candidates) {
    const cleaned = c.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      const obj = JSON.parse(cleaned);
      if (obj && Array.isArray(obj.scenes)) return obj;
    } catch { /* try next */ }
  }
  return null;
}

function newMsgId() {
  return Math.random().toString(36).slice(2, 10);
}

function newSessionId() {
  // AgentCore runtime requires runtime-session-id length >= 33. Pad generously.
  return `tl-${Date.now()}-${Math.random().toString(36).slice(2, 14)}-padpadpadpadpad`;
}

/** Remove <plan>...</plan> and JSON code fences from streamed text so the
 *  chat thread shows only the agent's prose. The full text is still parsed
 *  separately for plan extraction. */
function stripPlanBlock(text: string): string {
  let out = text.replace(/<plan>[\s\S]*?<\/plan>/gi, "");
  // Open <plan> tag with no close yet: hide everything from there forward
  // so partial JSON isn't shown mid-stream.
  const openOnly = out.indexOf("<plan>");
  if (openOnly >= 0) out = out.slice(0, openOnly);
  return out.replace(/```(?:json)?\s*[\s\S]*?```/g, "").trim();
}

/** Stream one agent turn and feed text deltas into onDelta. Returns the full
 *  accumulated text so the caller can parse a plan out of it.
 *  `onEvent` (optional) fires for every stream event so callers can
 *  drive node-tracking on the live architecture sidebar. */
async function streamTurn(
  ksId: string,
  prompt: string,
  sessionId: string,
  onDelta: (proseSoFar: string) => void,
  onEvent?: (ev: { type: string; tool?: string }) => void,
): Promise<string> {
  let acc = "";
  for await (const ev of streamAgentTurn({
    knowledge_store_id: ksId,
    prompt,
    session_id: sessionId,
  })) {
    onEvent?.(ev as { type: string; tool?: string });
    if (ev.type === "text_delta") {
      acc += ev.delta;
      onDelta(stripPlanBlock(acc));
    } else if (ev.type === "plan_corrected") {
      // Runtime rewrote the <plan> JSON to satisfy the duration target.
      // Replace the running buffer wholesale so extractPlan() picks up the
      // corrected scenes. Any text_delta that follows (e.g. the enforcer's
      // note) appends normally.
      acc = ev.text;
      onDelta(stripPlanBlock(acc));
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  if (!acc.trim()) throw new Error("Agent returned no text — likely the 5-min runtime cap was hit. Try a simpler request.");
  return acc;
}

/** Tiny inline spinner — used inside the render button while the stitch
 *  job is being submitted and while it's progressing. Uses currentColor so
 *  it inherits the button's text color (looks right on btn-cue and btn). */
function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      style={{ animation: "rc-spin 0.9s linear infinite" }}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 1-9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** Renders a clip thumbnail. Delegates to the shared SmartClipThumb so the
 *  per-clip blocks and the channel-player rail strip always pick the same
 *  frame for a given clip (brightness-aware midpoint sampling). */
function ClipThumb({
  startTime, endTime, asset, height, className = "",
}: { startTime: string; endTime?: string; asset?: Asset; height: number; className?: string }) {
  return (
    <SmartClipThumb
      start={startTime}
      end={endTime}
      asset={asset}
      className={`rounded-sm overflow-hidden ${className}`}
      style={{ height }}
    />
  );
}

export function RoughCut() {
  const ks = useStore((s) => s.ks);
  const [script, setScript] = useState(SAMPLE_SCRIPT);
  const [fps, setFps] = useState(24);
  const [plan, setPlan] = useState<RoughCutPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [assetCache, setAssetCache] = useState<Record<string, Asset>>({});
  const [render, setRender] = useState<StitchJob | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  // True between the moment the producer clicks the render button and the
  // first response from /stitch (MediaConvert CreateJob takes ~2-4s). Lets
  // the button switch to a busy state immediately instead of looking
  // unresponsive while the request is in flight.
  const [renderSubmitting, setRenderSubmitting] = useState(false);
  const renderPollRef = useRef<number | null>(null);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>("");
  const [followup, setFollowup] = useState("");

  // Live arch tracking — drives the right-rail diagram. Updated by the
  // stream loop in generate() / sendFollowup() as agent events land.
  const [activeNode, setActiveNode] = useState<NodeId | null>(null);
  const [nodeHistory, setNodeHistory] = useState<NodeId[]>([]);

  const recordNode = (n: NodeId) => {
    setActiveNode((prev) => {
      if (prev && prev !== n) setNodeHistory((h) => h.includes(prev) ? h : [...h, prev]);
      return n;
    });
  };
  const trackEvent = (ev: { type: string; tool?: string }) => {
    const node = nodeForEvent(ev);
    if (node) {
      recordNode(node);
      if (ev.type === "tool_call") {
        const downstream = downstreamFor(ev.tool);
        if (downstream) setTimeout(() => recordNode(downstream), 400);
      }
    }
    if (ev.type === "done") setTimeout(() => setActiveNode(null), 1200);
  };

  // Consume any pending restore the drawer leaves in the global store.
  // Subscribing covers both cross-tab restore (RoughCut mounting fresh)
  // and in-tab restore (RoughCut already mounted, the store update is
  // what we react to).
  const pendingRestore = useStore((s) => s.pendingRestore);
  useEffect(() => {
    if (pendingRestore && pendingRestore.kind === "rough_cut") {
      restoreEntry(pendingRestore);
      setGlobal({ pendingRestore: undefined });
    }
  }, [pendingRestore]);

  // Persist the active entry id across refreshes. On mount, if there's a
  // remembered id and a matching history row, restore it silently — the
  // producer doesn't have to re-open History after a refresh.
  useEffect(() => {
    if (plan || activeEntryId) return; // only on a fresh mount
    let lastId: string | null = null;
    try { lastId = localStorage.getItem(LS_LAST_ROUGHCUT_ENTRY); } catch {}
    if (!lastId) return;
    const entries = loadHistory();
    const entry = entries.find((e) => e.id === lastId && e.kind === "rough_cut") as RoughCutHistoryEntry | undefined;
    if (entry) restoreEntry(entry);
    else { try { localStorage.removeItem(LS_LAST_ROUGHCUT_ENTRY); } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the remembered id in sync with the in-memory active entry. Cleared
  // on "new cut" so a refresh after that lands on the empty state, not the
  // previous plan.
  useEffect(() => {
    try {
      if (activeEntryId) localStorage.setItem(LS_LAST_ROUGHCUT_ENTRY, activeEntryId);
      else localStorage.removeItem(LS_LAST_ROUGHCUT_ENTRY);
    } catch {}
  }, [activeEntryId]);

  // Tick the elapsed-time meter while a plan is being generated.
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
  }, [busy]);

  // When a plan lands, prefetch assets (primaries + alternates) so cards
  // have filenames and thumbnails.
  useEffect(() => {
    if (!plan) return;
    const ids = new Set<string>();
    for (const s of plan.scenes) for (const c of s.clips || []) {
      ids.add(c.video_reference);
      for (const a of c.alternatives || []) ids.add(a.video_reference);
    }
    const need = [...ids].filter((id) => !assetCache[id]);
    if (!need.length) return;
    Promise.all(need.map((id) => getAsset(id).then((a) => [id, a] as const).catch(() => null))).then((rs) => {
      const next: Record<string, Asset> = {};
      for (const r of rs) if (r) next[r[0]] = r[1];
      setAssetCache((cur) => ({ ...cur, ...next }));
    });
  }, [plan]);

  const totalSec = useMemo(() => (plan ? totalDuration(plan) : 0), [plan]);
  const clipCount = useMemo(() => (plan ? plan.scenes.reduce((s, sc) => s + (sc.clips?.length || 0), 0) : 0), [plan]);

  // Swap an alternate into the primary slot.  The old primary is demoted to
  // the head of the alternatives list so the move stays reversible; rank on
  // the demoted entry borrows the alt's rank slot so the swapped order is
  // sensible if Marengo ever re-runs.
  const swapAlt = (sceneIdx: number, clipIdx: number, altIdx: number) => {
    setPlan((p) => {
      if (!p) return p;
      const scenes = p.scenes.slice();
      const scene = { ...scenes[sceneIdx] };
      const clips = scene.clips.slice();
      const clip = clips[clipIdx];
      const alts = clip.alternatives || [];
      const chosen = alts[altIdx];
      if (!chosen) return p;
      const demoted = {
        video_reference: clip.video_reference,
        start_time: clip.start_time,
        end_time: clip.end_time,
        rank: chosen.rank,
        why_alt: clip.take_note || "previous primary",
      };
      const newAlts = [demoted, ...alts.filter((_, i) => i !== altIdx)];
      clips[clipIdx] = {
        ...clip,
        video_reference: chosen.video_reference,
        start_time: chosen.start_time,
        end_time: chosen.end_time,
        take_note: chosen.why_alt || clip.take_note,
        alternatives: newAlts,
      };
      scene.clips = clips;
      scenes[sceneIdx] = scene;
      return { ...p, scenes };
    });
  };

  const updateLastAssistant = (text: string) => {
    setMessages((m) => {
      const i = m.length - 1;
      if (i < 0 || m[i].role !== "assistant") return m;
      const next = m.slice();
      next[i] = { ...next[i], text };
      return next;
    });
  };

  const generate = async () => {
    if (!ks || !script.trim() || busy) return;
    setBusy(true); setErr(null); setPlan(null); setElapsed(0);
    setRender(null); setRenderErr(null);
    if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }

    const sid = sessionId || newSessionId();
    if (!sessionId) setSessionId(sid);

    const userMsg: ChatMessage = { id: newMsgId(), role: "user", text: script };
    const asstMsg: ChatMessage = { id: newMsgId(), role: "assistant", text: "" };
    setMessages([userMsg, asstMsg]);

    try {
      setNodeHistory([]);
      recordNode("runtime");
      const wrapped = `${AGENT_INSTRUCTIONS}\n\n---\n\nBrief:\n${script.trim()}\n\nKnowledge store id: ${ks._id}\n\nGo.`;
      const full = await streamTurn(ks._id, wrapped, sid, updateLastAssistant, trackEvent);

      // Prose-only is a legitimate first response: the agent may legitimately
      // bail out (empty index, ambiguous brief, missing KS context) and reply
      // with a plain explanation. Don't treat that as an error - keep the
      // chat thread visible so the producer sees the explanation and can
      // follow up.
      const raw = extractPlan(full);
      const clean = raw ? sanitizePlan(raw) : null;
      const hasPlan = !!(clean && clean.scenes.length);

      const finalMessages: ChatMessage[] = [userMsg, { ...asstMsg, text: stripPlanBlock(full) }];
      setMessages(finalMessages);
      if (hasPlan) setPlan(clean);

      const saved = saveEntry<RoughCutHistoryEntry>({
        kind: "rough_cut",
        title: hasPlan ? (clean!.title || "Untitled") : "(no plan yet)",
        script,
        fps,
        plan: hasPlan ? clean! : { scenes: [] } as RoughCutPlan,
        ks_id: ks._id,
        ks_name: ks.name,
        session_id: sid,
        messages: finalMessages,
      });
      setActiveEntryId(saved.id);
      window.dispatchEvent(new Event("history:updated"));
    } catch (e) {
      setErr(String(e));
      updateLastAssistant(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const sendFollowup = async () => {
    if (!ks || !followup.trim() || busy) return;
    const text = followup.trim();
    setFollowup("");
    setBusy(true); setErr(null);

    const sid = sessionId || newSessionId();
    if (!sessionId) setSessionId(sid);

    const userMsg: ChatMessage = { id: newMsgId(), role: "user", text };
    const asstMsg: ChatMessage = { id: newMsgId(), role: "assistant", text: "" };
    setMessages((m) => [...m, userMsg, asstMsg]);

    try {
      // If a plan already exists, embed it inline so the agent reasons over
      // the live state of the cut. If not (e.g. the first turn replied
      // prose-only because the index was empty and the producer is now
      // retrying), skip the CURRENT PLAN block.
      setNodeHistory([]);
      recordNode("runtime");
      const wrapped = plan
        ? `[ks: ${ks._id}]\n\n[CURRENT PLAN]\n<plan>\n${JSON.stringify(plan, null, 2)}\n</plan>\n\n[FOLLOWUP]\n${text}`
        : `${AGENT_INSTRUCTIONS}\n\n---\n\n[ks: ${ks._id}]\n\n[FOLLOWUP]\n${text}`;
      const full = await streamTurn(ks._id, wrapped, sid, updateLastAssistant, trackEvent);

      const prose = stripPlanBlock(full);
      setMessages((m) => {
        const i = m.length - 1;
        if (i < 0) return m;
        const next = m.slice();
        next[i] = { ...next[i], text: prose };
        return next;
      });

      // Structural reply: a fresh <plan> block. Update the timeline.
      const raw = extractPlan(full);
      let nextPlan = plan;
      if (raw) {
        const clean = sanitizePlan(raw);
        if (clean.scenes.length) {
          nextPlan = clean;
          setPlan(clean);
        }
      }

      // Persist conversation + (possibly) updated plan onto the active history entry.
      if (activeEntryId) {
        updateEntry(activeEntryId, {
          plan: nextPlan || ({ scenes: [] } as RoughCutPlan),
          messages: [...messages, userMsg, { ...asstMsg, text: prose }],
        });
        window.dispatchEvent(new Event("history:updated"));
      }
    } catch (e) {
      setErr(String(e));
      updateLastAssistant(`Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const newConversation = () => {
    setMessages([]);
    setSessionId("");
    setPlan(null);
    setActiveEntryId(null);
    setFollowup("");
    setErr(null);
    setRender(null); setRenderErr(null);
  };

  const restoreEntry = (entry: RoughCutHistoryEntry) => {
    setScript(entry.script);
    setFps(entry.fps);
    setActiveEntryId(entry.id);
    setErr(null);
    setRenderErr(null);
    setPlan(entry.plan);
    setMessages(entry.messages || []);
    setSessionId(entry.session_id || "");
    setFollowup("");
    if (entry.render?.status === "COMPLETE" && entry.render.output_url) {
      setRender({
        job_id: entry.render.job_id,
        render_id: entry.render.render_id,
        status: "COMPLETE",
        output_url: entry.render.output_url,
        percent: 100,
      });
    } else {
      setRender(null);
    }
  };

  const removeEntry = (id: string) => {
    deleteEntry(id);
    window.dispatchEvent(new Event("history:updated"));
    if (activeEntryId === id) setActiveEntryId(null);
  };

  const downloadEDL = () => {
    if (!plan) return;
    const edl = generateEDL(plan, { fps, lookup: (id) => assetCache[id] });
    const blob = new Blob([edl], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(plan.title || "rough_cut").replace(/\W+/g, "_").toLowerCase()}_${fps}fps.edl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderPreview = async () => {
    if (!plan) return;
    setRenderErr(null);
    setRenderSubmitting(true);
    if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }
    try {
      const job = await startStitch(plan);
      setRender(job);
      setRenderSubmitting(false);
      const entryId = activeEntryId;
      renderPollRef.current = window.setInterval(async () => {
        try {
          const next = await getStitch(job.job_id);
          setRender(next);
          if (next.status === "COMPLETE" || next.status === "ERROR" || next.status === "CANCELED") {
            if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }
            if (next.status === "ERROR") setRenderErr(next.error || "render failed");
            // Persist the render outcome onto the history entry so it survives reload.
            if (entryId) {
              updateEntry(entryId, {
                render: {
                  job_id: next.job_id,
                  render_id: next.render_id,
                  output_url: next.output_url,
                  status: next.status,
                },
              });
              window.dispatchEvent(new Event("history:updated"));
            }
          }
        } catch (e) {
          setRenderErr(String(e));
          if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }
        }
      }, 3000);
    } catch (e) {
      setRenderErr(String(e));
      setRenderSubmitting(false);
    }
  };

  // Cleanup poll interval on unmount.
  useEffect(() => {
    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  }, []);

  // Three-pane studio. The left rail holds the brief (accordion-collapsing
  // after the first turn) plus the running chat thread. The center hosts
  // the timeline. The right rail is a placeholder until Step 5 lands the
  // live architecture diagram + tool catalog.
  const hasMessages = messages.length > 0;
  const briefSummary = script.split("\n").find((l) => l.trim().length > 0)?.trim() || "untitled brief";
  const archOpen = useStore((s) => s.archOpen);

  return (
    <div
      className="grid h-full min-h-0"
      style={{ gridTemplateColumns: archOpen ? "320px 1fr 320px" : "320px 1fr" }}
    >
      {/* LEFT RAIL — brief accordion + chat thread */}
      <aside className="flex flex-col min-h-0 border-r" style={{ borderColor: "var(--color-rule)" }}>
        {/* § Brief — collapses to a 1-line summary after the first turn */}
        {hasMessages ? (
          <details className="border-b group" style={{ borderColor: "var(--color-rule)" }}>
            <summary className="px-5 py-3 cursor-pointer flex items-center gap-2 hover:bg-[var(--color-surface)] transition-colors list-none">
              <span className="font-mono text-[10px] group-open:rotate-90 transition-transform inline-block w-2" style={{ color: "var(--color-ink-faint)" }}>▸</span>
              <span className="label">Brief</span>
              <span className="text-xs ml-2 truncate flex-1" style={{ color: "var(--color-ink-soft)" }}>
                {briefSummary.slice(0, 64)}{briefSummary.length > 64 ? "…" : ""}
              </span>
            </summary>
            <div className="px-5 pb-4 pt-2">
              <textarea
                className="bg-transparent border w-full p-3 outline-none text-sm leading-relaxed font-mono rounded-[var(--radius-card)]"
                style={{ borderColor: "var(--color-rule)", minHeight: 200 }}
                value={script}
                onChange={(e) => setScript(e.target.value)}
              />
              <button
                className="btn btn-cue mt-3 w-full"
                onClick={() => { newConversation(); void generate(); }}
                disabled={busy}
                title="discard the current conversation and assemble a fresh rough cut from this brief"
              >
                {busy ? `re-assembling… ${elapsed}s` : "re-assemble from brief"}
              </button>
            </div>
          </details>
        ) : (
          <div className="px-5 pt-5 pb-4 border-b overflow-hidden" style={{ borderColor: "var(--color-rule)" }}>
            <div className="flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="label whitespace-nowrap">§ Brief</span>
                <Pill
                  label=""
                  value={String(fps)}
                  options={DEFAULT_FPS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
                  onChange={(v) => setFps(Number(v))}
                  // Collapse to just "24 fps" in the rail; full label
                  // ("24 fps · cinema (DCP)") still shows in the popover.
                  triggerLabel={(_cur, v) => `${v} fps`}
                />
              </div>
              <button
                type="button"
                onClick={() => setGlobal({ historyOpen: true })}
                title="Browse saved rough cuts"
                className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px] transition-colors hover:text-[var(--color-cue)] hover:border-[var(--color-cue)]"
                style={{
                  background: "var(--color-surface)",
                  border: "1px solid var(--color-rule)",
                  color: "var(--color-ink-soft)",
                }}
              >
                <span style={{ fontSize: 11 }}>⟲</span>
                history
              </button>
            </div>
            {/* Canned brief chooser — one chip per cut-type the agent
                recognizes. Clicking loads that template into the textarea;
                the producer can then edit before submitting. */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(Object.keys(BRIEF_TEMPLATES) as CutType[]).map((t) => {
                const tpl = BRIEF_TEMPLATES[t];
                const active = script.trim() === tpl.brief.trim();
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setScript(tpl.brief)}
                    title={tpl.tagline}
                    className="inline-flex items-center px-2 py-0.5 rounded-full font-mono text-[10px] transition-colors"
                    style={{
                      background: active ? "var(--color-surface-2)" : "var(--color-surface)",
                      border: `1px solid ${active ? "var(--color-cue)" : "var(--color-rule)"}`,
                      color: active ? "var(--color-cue)" : "var(--color-ink-soft)",
                    }}
                  >
                    {tpl.label}
                  </button>
                );
              })}
            </div>
            <textarea
              className="bg-transparent border w-full p-3 mt-2 outline-none text-sm leading-relaxed font-mono rounded-[var(--radius-card)]"
              style={{ borderColor: "var(--color-rule)", height: "calc(100vh - 410px)", minHeight: 200 }}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="Pick a template above, or type your own brief…"
            />
            <div className="label mt-2" style={{ color: "var(--color-ink-faint)" }}>
              {script.length.toLocaleString()} chars
            </div>
            <button
              className="btn btn-cue mt-3 w-full"
              onClick={generate}
              disabled={busy || !ks || !script.trim()}
            >
              {busy ? `assembling… ${elapsed}s` : "assemble rough cut →"}
            </button>
            {err && (
              <pre className="font-mono text-[11px] mt-3 p-2 whitespace-pre-wrap rounded-[var(--radius-card)]" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>{err}</pre>
            )}
          </div>
        )}

        {/* § Chat — visible only after at least one turn has fired */}
        {hasMessages && (
          <div className="flex flex-col min-h-0 flex-1">
            <div className="px-5 pt-3 pb-2 flex items-baseline justify-between">
              <span className="label">§ Chat</span>
              <div className="flex items-center gap-3">
                <button
                  className="label hover:text-[var(--color-ink)] transition-colors"
                  onClick={() => setGlobal({ historyOpen: true })}
                  title="history"
                >
                  history
                </button>
                <button
                  className="label hover:text-[var(--color-ink)] transition-colors"
                  onClick={newConversation}
                  disabled={busy}
                  title="discard this thread and start a new rough cut"
                >
                  + new cut
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-3">
              <ChatThread messages={messages} streaming={busy} />
            </div>
            <div className="px-5 pb-4 border-t pt-3" style={{ borderColor: "var(--color-rule)" }}>
              <textarea
                className="bg-transparent border w-full p-2 outline-none text-sm font-mono rounded-[var(--radius-card)]"
                style={{ borderColor: "var(--color-rule)", minHeight: 64 }}
                rows={2}
                value={followup}
                onChange={(e) => setFollowup(e.target.value)}
                placeholder="ask the agent to swap, extend, describe a clip…  (⌘↩)"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void sendFollowup();
                  }
                }}
                disabled={busy}
              />
              <div className="flex items-center justify-between mt-2">
                <div className="label" style={{ color: "var(--color-ink-faint)" }}>
                  {busy ? "agent thinking…" : "⌘↩ to send"}
                </div>
                <button
                  className="btn btn-cue"
                  onClick={sendFollowup}
                  disabled={busy || !followup.trim()}
                >
                  {busy ? "..." : "send →"}
                </button>
              </div>
              {err && (
                <pre className="font-mono text-[11px] mt-3 p-2 whitespace-pre-wrap rounded-[var(--radius-card)]" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>{err}</pre>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* CENTER — timeline. Internal scroll; EDL controls dock at bottom. */}
      <section className="flex flex-col min-h-0 overflow-hidden">
        <div className="flex items-baseline justify-between px-8 pt-3 pb-2 border-b" style={{ borderColor: "var(--color-rule)" }}>
          <div>
            <div className="label">§ Timeline</div>
            {plan && (
              <p className="font-display text-base mt-0.5 tracking-tight">
                {plan.title || "Rough Cut"}
              </p>
            )}
          </div>
          {plan && (
            <div className="text-right">
              <div className="font-mono text-base">{fmtDuration(totalSec)}</div>
              <div className="label">{plan.scenes.length} scenes · {clipCount} clips</div>
            </div>
          )}
        </div>

        {/* Scroll container — pt-0 (not py-6) so the sticky rail inside can
            pin flush against the title bar above with no padding gap. The
            old pt-6 created a 24px zone where the notes paragraph could
            scroll up into view ABOVE the pinned rail. Initial content
            (empty/busy/notes states) gets its own mt-6 to compensate. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-8 pb-6">
          {!plan && !busy && messages.length === 0 && (
            <p className="text-sm max-w-md mt-6" style={{ color: "var(--color-ink-soft)" }}>
              Paste a script in the left rail and click <span className="font-mono">assemble rough cut →</span>.
              The cut will appear here scene by scene.
            </p>
          )}

          {!plan && !busy && messages.length > 0 && (
            <div data-testid="no-plan-placeholder" className="py-4 mt-6">
              <p className="text-sm max-w-md" style={{ color: "var(--color-ink-soft)" }}>
                No EDL yet — see the agent's reply in the chat. Once the
                blocker is resolved (most often a missing vector index), reply with
                <span className="font-mono"> "try again"</span> to retry the cut.
              </p>
            </div>
          )}

          {busy && (
            <p className="caret font-display text-xl mt-6" style={{ color: "var(--color-ink-soft)" }}>
              <RotatingStatus elapsed={elapsed} />
            </p>
          )}

          {plan && (
            <>
              {/* Back-to-back HLS preview. The strip below the video is
                  sticky (see stickyMeta) so the producer can scroll the
                  scenes list to pick alternates while keeping the rail
                  pinned at the top. The video itself scrolls away.
                  NOTE: no wrapper div around ChannelPlayer — sticky needs
                  the meta block to be a direct child of the scroll
                  container so its parent extends through the scenes list. */}
              <ChannelPlayer
                channel={planToChannel(plan, "agent", assetCache)}
                autoplay={false}
                loop={false}
                stickyMeta
              />

              {/* Notes paragraph between the rail and the scenes — its
                  natural editorial position. As you scroll, it slides up
                  UNDER the sticky rail (rail has z-20 + solid background)
                  so no bleed-through. */}
              {plan.notes && (
                <p className="text-sm italic mt-6 mb-6 max-w-2xl" style={{ color: "var(--color-ink-soft)" }}>
                  — {plan.notes}
                </p>
              )}

              <ol className="space-y-6">
                {plan.scenes.map((sc, i) => (
                  <SceneBlock
                    key={sc.scene_id || i}
                    scene={sc}
                    index={i}
                    fps={fps}
                    assetCache={assetCache}
                    onSwap={(clipIdx, altIdx) => swapAlt(i, clipIdx, altIdx)}
                  />
                ))}
              </ol>

              <RenderPanel render={render} err={renderErr} />
            </>
          )}
        </div>

        {plan && (
          <div className="border-t px-8 py-1.5 flex items-center gap-2 flex-wrap" style={{ borderColor: "var(--color-rule)" }}>
            <button className="btn btn-sm" onClick={downloadEDL}>Export EDL ({fps} fps) ↓</button>
            <button
              className="btn btn-sm btn-cue"
              onClick={renderPreview}
              disabled={renderSubmitting || (!!render && render.status !== "ERROR" && render.status !== "CANCELED" && render.status !== "COMPLETE")}
            >
              {renderSubmitting ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner /> submitting…
                </span>
              ) : render?.status === "PROGRESSING" || render?.status === "SUBMITTED" ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner /> rendering… {render.percent || 0}%
                </span>
              ) : render?.status === "COMPLETE" ? (
                "re-render preview →"
              ) : (
                "Render preview →"
              )}
            </button>
            {render?.status === "COMPLETE" && render.output_url && (
              <a
                className="label hover:text-[var(--color-ink)] transition-colors"
                href={render.output_url}
                download={`rough-cut-${(plan.title || "preview").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.mp4`}
                title="Download the rendered preview as MP4"
              >
                Download MP4 ↓
              </a>
            )}
          </div>
        )}
      </section>

      {/* RIGHT RAIL — live architecture sidebar. Pills light up as the
          agent's tools fire during generate() / sendFollowup() runs.
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

// Flatten a RoughCutPlan into a Channel-shape so ChannelPlayer can play it
// back-to-back (no MediaConvert stitch). Each scene's clips get serialized
// into a single programs[] array; HH:MM:SS source ranges become seconds.
function planToChannel(plan: RoughCutPlan, idPrefix: string, assetCache: Record<string, Asset>): Channel {
  const programs = plan.scenes.flatMap((sc, si) =>
    (sc.clips || []).map((c, ci) => {
      const start = parseTime(c.start_time);
      const end   = parseTime(c.end_time);
      return {
        id: `${idPrefix}-s${si}-c${ci}`,
        name: c.role
          ? `${sc.scene_name || `Scene ${si + 1}`} · ${c.role}`
          : (sc.scene_name || `Scene ${si + 1}`),
        asset_id: c.video_reference,
        asset_filename: assetCache[c.video_reference]?.filename,
        source_start: start,
        source_end:   end,
        scheduled_start: c.start_time,
        scheduled_duration_sec: Math.max(end - start, 0),
      };
    })
  );
  const total = programs.reduce((s, p) => s + Math.max((p.source_end || 0) - (p.source_start || 0), 0), 0);
  return {
    channel_id: idPrefix,
    name: plan.title || "Rough Cut",
    tagline: plan.notes || "",
    audience: "",
    programs,
    total_duration_sec: total,
  };
}

function ChatThread({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const ks = useStore((s) => s.ks);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  if (!messages.length) {
    return (
      <p className="text-sm py-8" style={{ color: "var(--color-ink-faint)" }}>
        The conversation will start once the first cut is generated.
      </p>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="space-y-5 overflow-y-auto pr-2"
      style={{ maxHeight: "55vh" }}
      tabIndex={0}
      role="region"
      aria-label="Conversation"
    >
      {messages.map((m, i) => {
        const isUser = m.role === "user";
        const isLast = i === messages.length - 1;
        const isStreaming = streaming && isLast && !isUser;
        return (
          <div key={m.id}>
            <div
              className="label"
              style={{ color: isUser ? "var(--color-cue)" : "var(--color-ink-faint)" }}
            >
              {isUser ? "You" : "Agent"}
            </div>
            {isUser ? (
              // Producer messages render verbatim (mono, pre-wrap). What
              // they typed is what they see.
              <p
                className="text-sm mt-1 whitespace-pre-wrap leading-relaxed"
                style={{ color: "var(--color-ink)", fontFamily: "var(--font-mono)" }}
              >
                {m.text}
              </p>
            ) : (
              // Agent messages run through ResponseMarkdown so 24-hex
              // asset_ids become clickable chips, markdown formats, and
              // any `<plan>` block is stripped (it's already extracted
              // onto the timeline above).
              <div className="text-sm mt-1 leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                {m.text ? (
                  <ResponseMarkdown text={m.text} ksId={ks?._id} />
                ) : isStreaming ? (
                  <span style={{ color: "var(--color-ink-faint)" }}>thinking…</span>
                ) : null}
                {isStreaming && m.text && (
                  <span className="caret" style={{ color: "var(--color-cue)" }}>▌</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SceneBlock({
  scene, index, fps, assetCache, onSwap,
}: {
  scene: RoughCutPlan["scenes"][number];
  index: number;
  fps: number;
  assetCache: Record<string, Asset>;
  onSwap?: (clipIdx: number, altIdx: number) => void;
}) {
  const sceneSec = scene.clips.reduce((s, c) => s + Math.max(parseTime(c.end_time) - parseTime(c.start_time), 0), 0);

  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.3), duration: 0.35 }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <div>
          <span className="label" style={{ color: "var(--color-cue)" }}>
            scene {scene.scene_id || String(index + 1).padStart(2, "0")}
          </span>
          <h3 className="font-display text-xl mt-1">{scene.scene_name}</h3>
          {scene.scene_description && (
            <p className="text-sm mt-1 max-w-2xl" style={{ color: "var(--color-ink-soft)" }}>{scene.scene_description}</p>
          )}
        </div>
        <span className="font-mono text-sm" style={{ color: "var(--color-ink-soft)" }}>{fmtDuration(sceneSec)}</span>
      </div>
      <ul className="space-y-2">
        {scene.clips.map((c, j) => (
          <ClipRow
            key={j}
            index={j}
            clip={c}
            fps={fps}
            asset={assetCache[c.video_reference]}
            assetCache={assetCache}
            onSwap={onSwap ? (altIdx) => onSwap(j, altIdx) : undefined}
          />
        ))}
      </ul>
    </motion.li>
  );
}

function ClipRow({ index, clip, asset, assetCache, onSwap }: {
  index: number;
  clip: RoughCutPlan["scenes"][number]["clips"][number];
  fps: number;
  asset?: Asset;
  assetCache?: Record<string, Asset>;
  onSwap?: (altIdx: number) => void;
}) {
  const dur = Math.max(parseTime(clip.end_time) - parseTime(clip.start_time), 0);
  const [altsOpen, setAltsOpen] = useState(false);
  const alts = clip.alternatives || [];
  const hasAlts = alts.length > 0;
  return (
    <li className="clip-card p-3">
      <div
        className="grid grid-cols-[64px_1fr_auto] gap-4 items-center cursor-pointer"
        onClick={() => setGlobal({ activeAssetId: clip.video_reference })}
      >
      <ClipThumb startTime={clip.start_time} endTime={clip.end_time} asset={asset} height={36} />
      <div>
        <div className="font-mono text-xs" style={{ color: "var(--color-ink-soft)" }}>
          {String(index + 1).padStart(2, "0")} ·{" "}
          <span style={{ color: "var(--color-ink)" }}>{asset?.filename || clip.video_reference.slice(0, 18)}</span>
          {clip.role && <span style={{ color: "var(--color-cue)" }}> · {clip.role}</span>}
        </div>
        {clip.take_note && (
          <p className="text-xs mt-0.5" style={{ color: "var(--color-ink-soft)" }}>{clip.take_note}</p>
        )}
        <EntityChips assetId={clip.video_reference} max={4} />
      </div>
      <div className="font-mono text-xs whitespace-nowrap text-right" style={{ color: "var(--color-ink)" }}>
        {clip.start_time}<br />
        <span style={{ color: "var(--color-ink-faint)" }}>▸</span>{" "}
        {clip.end_time}<br />
        <span style={{ color: "var(--color-cue)" }}>{fmtDuration(dur)}</span>
      </div>
      </div>

      {hasAlts && (
        <div className="mt-2 pt-2" style={{ borderTop: "1px dashed var(--color-rule)" }}>
          <button
            type="button"
            className="label text-[10px] hover:text-[var(--color-cue)]"
            onClick={(e) => { e.stopPropagation(); setAltsOpen((v) => !v); }}
            title="Marengo-ranked swap candidates from the same query"
          >
            {altsOpen ? "▾" : "▸"} {alts.length} alternate{alts.length === 1 ? "" : "s"} · vector-ranked
          </button>

          {altsOpen && (
            <ul className="mt-2 space-y-1.5">
              {alts.map((alt, k) => {
                const altAsset = assetCache?.[alt.video_reference];
                const altDur = Math.max(parseTime(alt.end_time) - parseTime(alt.start_time), 0);
                return (
                  <li
                    key={k}
                    className="grid grid-cols-[48px_1fr_auto_auto] gap-3 items-center px-2 py-1.5 rounded-sm"
                    style={{ background: "var(--color-surface)" }}
                  >
                    <ClipThumb startTime={alt.start_time} endTime={alt.end_time} asset={altAsset} height={28} />
                    <div className="min-w-0">
                      <div className="font-mono text-[10px] truncate" style={{ color: "var(--color-ink-soft)" }}>
                        {alt.rank != null && (
                          <span style={{ color: "var(--color-cue)" }}>rank {alt.rank}</span>
                        )}
                        {alt.rank != null && " · "}
                        <span style={{ color: "var(--color-ink)" }}>
                          {altAsset?.filename || alt.video_reference.slice(0, 18)}
                        </span>
                      </div>
                      {alt.why_alt && (
                        <p className="text-[10px] mt-0.5 truncate" style={{ color: "var(--color-ink-soft)" }}>
                          {alt.why_alt}
                        </p>
                      )}
                    </div>
                    <div className="font-mono text-[10px] whitespace-nowrap text-right" style={{ color: "var(--color-ink-faint)" }}>
                      {alt.start_time} ▸ {alt.end_time}<br />
                      <span style={{ color: "var(--color-cue)" }}>{fmtDuration(altDur)}</span>
                    </div>
                    {onSwap ? (
                      <button
                        type="button"
                        className="btn btn-cue text-[10px] px-2 py-0.5"
                        onClick={(e) => { e.stopPropagation(); onSwap(k); }}
                        title="Promote this alternate to the primary slot"
                      >
                        use this →
                      </button>
                    ) : (
                      <span className="label text-[9px]" style={{ color: "var(--color-ink-faint)" }}>read-only</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function HistoryStrip({
  entries, activeId, onRestore, onDelete,
}: {
  entries: RoughCutHistoryEntry[];
  activeId: string | null;
  onRestore: (e: RoughCutHistoryEntry) => void;
  onDelete: (id: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="mb-10">
      <div className="flex items-baseline justify-between mb-3">
        <div className="label">§ Saved cuts · {entries.length}</div>
        <div className="label" style={{ color: "var(--color-ink-faint)" }}>
          stored locally · click to restore
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-2 px-2" style={{ scrollbarWidth: "thin" }}>
        {entries.map((e) => {
          const sceneCount = e.plan.scenes.length;
          const clipCount = e.plan.scenes.reduce((s, sc) => s + (sc.clips?.length || 0), 0);
          const dur = totalDuration(e.plan);
          const active = e.id === activeId;
          const rendered = e.render?.status === "COMPLETE" && e.render.output_url;
          return (
            <div
              key={e.id}
              className="shrink-0 border p-3 cursor-pointer hover:border-[var(--color-cue-soft)] transition-colors"
              style={{
                width: 264,
                borderColor: active ? "var(--color-cue)" : "var(--color-rule)",
                background: active ? "rgba(255, 122, 26, 0.06)" : "var(--color-surface)",
              }}
              onClick={() => onRestore(e)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="label" style={{ color: active ? "var(--color-cue)" : "var(--color-ink-faint)" }}>
                  {relativeTime(e.created_at)}
                </span>
                <button
                  className="label hover:text-[var(--color-status-failed)]"
                  style={{ color: "var(--color-ink-faint)" }}
                  onClick={(ev) => { ev.stopPropagation(); onDelete(e.id); }}
                  title="remove from history"
                >
                  ×
                </button>
              </div>
              <div
                className="font-display text-lg leading-tight mt-1 truncate"
                style={{ color: active ? "var(--color-cue)" : "var(--color-ink)" }}
                title={e.title}
              >
                "{e.title}"
              </div>
              <div className="font-mono text-[10px] mt-2" style={{ color: "var(--color-ink-soft)" }}>
                {sceneCount} scenes · {clipCount} clips · {fmtDuration(dur)} · {e.fps}fps
              </div>
              {e.ks_name && (
                <div className="font-mono text-[10px] mt-1 truncate" style={{ color: "var(--color-ink-faint)" }}>
                  {e.ks_name}
                </div>
              )}
              <div className="mt-2 label" style={{ color: rendered ? "var(--color-status-ready)" : "var(--color-ink-faint)" }}>
                {rendered ? "✓ rendered" : "edl only"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RenderPanel({ render, err }: { render: StitchJob | null; err: string | null }) {
  if (err && !render) {
    return (
      <pre className="font-mono text-xs p-3 mt-2 whitespace-pre-wrap" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>{err}</pre>
    );
  }
  if (!render) return null;
  const pct = Math.max(0, Math.min(100, render.percent || (render.status === "COMPLETE" ? 100 : 0)));
  const tone = render.status === "ERROR" || render.status === "CANCELED"
    ? "var(--color-status-failed)"
    : render.status === "COMPLETE"
      ? "var(--color-status-ready)"
      : "var(--color-cue)";

  return (
    <div className="border p-4 mt-2" style={{ borderColor: "var(--color-rule)", background: "var(--color-surface)" }}>
      <div className="flex items-center justify-between">
        <div>
          <div className="label" style={{ color: tone }}>render · {render.status.toLowerCase()}</div>
          <div className="font-mono text-xs mt-1" style={{ color: "var(--color-ink-soft)" }}>
            {render.job_id}
            {render.clip_count ? ` · ${render.clip_count} clips` : ""}
          </div>
        </div>
        {render.status !== "COMPLETE" && render.status !== "ERROR" && (
          <div className="font-mono text-2xl" style={{ color: "var(--color-cue)" }}>{pct}%</div>
        )}
      </div>
      {render.status !== "COMPLETE" && render.status !== "ERROR" && (
        <div className="mt-3 h-1 w-full" style={{ background: "var(--color-surface-2)" }}>
          <motion.div
            className="h-full"
            style={{ background: "var(--color-cue)" }}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.4 }}
          />
        </div>
      )}
      {render.status === "COMPLETE" && render.output_url && (
        <video
          className="w-full mt-4"
          src={render.output_url}
          controls
          muted
          playsInline
          style={{ background: "black", maxHeight: 480 }}
        />
      )}
      {(err || render.error) && (
        <pre className="font-mono text-xs mt-3 whitespace-pre-wrap" style={{ color: "var(--color-status-failed)" }}>
          {err || render.error}
        </pre>
      )}
    </div>
  );
}

function Pill({
  label, value, options, onChange, triggerLabel,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  /** Optional override for the collapsed trigger text. If absent, falls
   *  back to the matched option's full label. Use this to keep the trigger
   *  narrow in tight rails (e.g. "24 fps") while still rendering the
   *  expanded label ("24 fps · cinema (DCP)") in the popover. */
  triggerLabel?: (cur: { value: string; label: string } | undefined, value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  const triggerText = triggerLabel ? triggerLabel(cur, value) : (cur?.label || value);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click outside / Escape closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      {label && <div className="label">{label}</div>}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full font-mono text-[11px] whitespace-nowrap transition-colors"
        style={{
          background: open ? "var(--color-surface-2)" : "var(--color-surface)",
          border: "1px solid var(--color-rule)",
          color: "var(--color-ink-soft)",
        }}
      >
        <span style={{ color: "var(--color-ink)" }}>{triggerText}</span>
        <span style={{ opacity: 0.6, fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 py-1 min-w-[220px] whitespace-nowrap rounded-[10px] shadow-lg"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}
        >
          {options.map((o) => {
            const isCur = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isCur}
                className="block w-full text-left px-3 py-1.5 font-mono text-[12px] hover:bg-[var(--color-surface-2)]"
                style={{ color: isCur ? "var(--color-cue)" : "var(--color-ink)" }}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                {isCur && <span className="mr-1" style={{ color: "var(--color-cue)" }}>✓</span>}
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Rotating status line shown while the agent is reasoning. Each line is
// paired with its own dwell duration (ms) so the rhythm isn't a robotic
// fixed-interval tick. Short pithy lines flick by; longer "what the agent
// is grinding on" lines linger. Soft fade-and-rise transition between
// messages keeps it from feeling mechanical.
const STATUS_LINES: { text: string; ms: number }[] = [
  { text: "Reading the room",                          ms: 2200 },
  { text: "Squinting at every clip",                   ms: 1800 },
  { text: "Asking the music what it thinks",           ms: 2600 },
  { text: "Auditioning shots in my head",              ms: 2400 },
  { text: "Pulling the good takes from the slush pile", ms: 2800 },
  { text: "Checking which trailer has the better light", ms: 3000 },
  { text: "Doing the part where it sounds like jazz",  ms: 2600 },
  { text: "Counting protagonists",                     ms: 1800 },
  { text: "Asking around — anyone seen this person?",  ms: 2800 },
  { text: "Politely rejecting the obvious choice",     ms: 2400 },
  { text: "Trimming the fat",                          ms: 1800 },
  { text: "Avoiding the same shot twice",              ms: 2600 },
  { text: "Looking for the moment before the moment",  ms: 3000 },
  { text: "Negotiating with the second act",           ms: 2800 },
  { text: "Holding for emphasis",                      ms: 1600 },
  { text: "Picking a quieter beat to land on",         ms: 2400 },
  { text: "Drafting one-liners for each pick",         ms: 2600 },
  { text: "Asking if this would play at 2 a.m.",       ms: 2800 },
  { text: "Sequencing scenes the way a producer would", ms: 2400 },
  { text: "Putting the kettle on",                     ms: 2000 },
  { text: "Pretending it's already Friday",            ms: 2000 },
  { text: "Wrapping it up like an editor on deadline", ms: 2400 },
  { text: "Final pass — kill the darlings",            ms: 2200 },
];

function RotatingStatus({ elapsed }: { elapsed: number }) {
  // Each message has its own dwell. We let the component drive its own
  // clock (vs. deriving from `elapsed`) so the transition timing is
  // smooth — `elapsed` only ticks once per second and would create a
  // saw-toothed cadence pinned to second boundaries.
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const dwell = STATUS_LINES[idx].ms;
    const t = setTimeout(() => setIdx((i) => (i + 1) % STATUS_LINES.length), dwell);
    return () => clearTimeout(t);
  }, [idx]);

  return (
    <span className="inline-flex items-baseline gap-2">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={idx}
          initial={{ opacity: 0, y: 6, filter: "blur(2px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -6, filter: "blur(2px)" }}
          transition={{ duration: 0.45, ease: [0.2, 0, 0, 1] }}
          className="inline-block"
        >
          {STATUS_LINES[idx].text}
        </motion.span>
      </AnimatePresence>
      <span style={{ color: "var(--color-ink-faint)" }}>· {elapsed}s</span>
    </span>
  );
}
