// "Rough Cut" — the headline workflow.
//
// User pastes a script (free-form prose, treatment, scene outline; the
// agent parses any of them). The AgentCore Strands agent reads the script
// plus the active KB's contents, assembles a scene-by-scene plan with clip
// references and timecodes, and the UI renders a producer-readable
// timeline with EDL export and (Phase 2) a MediaConvert preview render.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { streamAgentTurn } from "../lib/agent-api";
import { useStore } from "../lib/store";
import { getAsset, getStitch, startStitch, type Asset, type Channel, type StitchJob } from "../lib/api";
import { ChannelPlayer } from "./ChannelPlayer";
import { EntityChips } from "./EntityChips";
import { setState as setGlobal } from "../lib/store";
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
} from "../lib/roughcut-history";

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
const SAMPLE_SCRIPT = `Cold open: a striking visual that sets a tone. Could be a wide
landscape, a face in close-up, or a dramatic moment of stillness.

Act One — TENSION
Build atmosphere. Establish a sense of place or a character. Mix wider
context shots with intimate close-ups. Suggest something is about to happen.

Act Two — RELEASE
The high-energy section. Action, conflict, kinetic motion, fast cuts. Show
movement, scale, intensity. This is the punchline of the cut.

Act Three — CODA
The aftermath. A quieter beat — a face, a wide, a held moment. End on
something that lingers.`;

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
                  description: "2-4 ranked alternates from the same Marengo query, ordered by ascending rank.",
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

// Rough Cut prompt — the AgentCore Strands agent orchestrates TwelveLabs
// primitives directly with a cache-first discipline: pre-built profile_cache
// (DDB · sub-10ms) for the primary pick, then a Marengo pass per beat for
// alternates, and Pegasus only when neither covers a take-note.
const AGENT_INSTRUCTIONS = `You are an experienced film editor assembling a rough cut by orchestrating TwelveLabs primitives directly with a **cache-first** discipline. Use the pre-built profile_cache (DDB · sub-10ms) before reaching for live Marengo/Pegasus.

## Approach — keep it tight, ~3 turns total

### Turn 1 — fan out cheap calls in parallel (one model turn, multiple tool_calls):
- **get_kb_overview(ks)** — corpus moods, styles, sample titles, AND \`marengo_index_id\`.
- **list_kb_assets(ks, mood="<mood-1>")** — candidates for beat 1
- **list_kb_assets(ks, mood="<mood-2>")** — candidates for beat 2
- **list_kb_assets(ks, mood="<mood-3>")** — candidates for beat 3
- (etc., one per script beat)

Pick mood filters from the overview's \`top_moods\` — match each script beat to its closest mood (cold open → "landscape" or "contemplative"; tension → "tension" or "ominous"; release → "action" or "kinetic"; coda → "intimacy" or "melancholy").

If \`get_kb_overview\` returns \`cached: false\`, fall back to the legacy path: list_tl_indexes → parallel marengo_search per beat. Note this in your final \`notes\` field.

### Turn 2 — Marengo pass per beat (REQUIRED, even when Turn 1 covered the primary):
For EVERY beat, emit one \`marengo_search(index_id=<from overview>, query_text=<beat phrase>, knowledge_store_id=<ks>, page_limit=5)\` call — all in parallel. Marengo's ranked output is the source of the \`alternatives\` array. Producers need to swap a clip for a similarly-ranked option, and Marengo \`rank\` is the only signal that supports that.

### Turn 3 — emit the plan.

Schema:

<plan>
{
  "title": "string",
  "scenes": [{
    "scene_id": "01",
    "scene_name": "string",
    "scene_description": "optional",
    "clips": [{
      "video_reference": "<24-hex asset_id from list_kb_assets, or video_id from marengo_search>",
      "start_time": "HH:MM:SS",
      "end_time":   "HH:MM:SS",
      "role": "establishing|wide|medium|close-up|insert|cutaway|b-roll|hero",
      "take_note": "why this clip fits the beat — quote the cached one_liner if relevant",
      "alternatives": [
        {
          "video_reference": "<24-hex id from same marengo_search>",
          "start_time": "HH:MM:SS",
          "end_time":   "HH:MM:SS",
          "rank": 2,
          "why_alt": "one phrase, what makes this a defensible swap"
        }
        /* 2-4 entries, ordered by ascending rank. Drawn from the SAME
           marengo_search call that scored this beat. If the primary also
           came from Marengo, omit it from the alternatives list. */
      ]
    }]
  }],
  "total_estimated_duration": "MM:SS",
  "notes": "cache hit/miss count + which moods you mapped to which beats"
}
</plan>

## Time-range strategy when you only have cached assets (no marengo timecodes)

Pick a sensible default range based on \`role_hint\`:
- cold-open / atmospheric / hero-shot → 00:00:00 → 00:00:08 (opening beat)
- action-set-piece / kinetic → 00:00:30 → 00:00:38 (mid-asset, action usually starts after the setup)
- emotional-coda / intimacy → 00:01:00 → 00:01:08 (coda beats are usually deeper into the asset)
- b-roll / transition → 00:00:10 → 00:00:14 (short cutaway)

If you DID call marengo_search, prefer Marengo's actual start/end (clamped to ≤30s).

## Absolute rules

- Prefer cache (Tier 1) for the PRIMARY pick. Most beat primaries should resolve from cache alone.
- Run \`marengo_search\` per beat REGARDLESS of cache hit — it is the source of the \`alternatives\` array.
- Within a single turn, emit ALL tool calls for that turn at once — parallel execution is the point.
- video_reference is a 24-char hex id (asset_id from cache OR video_id from Marengo). Never invent ids, never use filenames.
- Lead with 1-2 sentences of commentary BEFORE the JSON (mention cache hit/miss + index used).
- Strict JSON: no trailing commas, no comments inside.

## Duration + range rules (silent clamping if violated)

- HH:MM:SS — three zero-padded components. "00:00:30" yes, "00:00:30:00" no, "0:30" no.
- Each clip 3-30 seconds.
- Per scene, 3-5 clips. Per cut, total 30s-4min.`;

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

async function runAgentRoughCut(
  ksId: string,
  script: string,
  onTrace?: (kind: "tool_call" | "tool_result" | "rationale" | "text", payload: unknown) => void,
): Promise<RoughCutPlan> {
  const wrappedPrompt = `${AGENT_INSTRUCTIONS}\n\n---\n\nProducer's brief / script:\n${script.trim()}\n\nKnowledge store id: ${ksId}\n\nGo.`;
  let acc = "";
  for await (const ev of streamAgentTurn({
    knowledge_store_id: ksId,
    prompt: wrappedPrompt,
  })) {
    if (ev.type === "text_delta") {
      acc += ev.delta;
      onTrace?.("text", acc);
    } else if (ev.type === "tool_call") {
      onTrace?.("tool_call", ev);
    } else if (ev.type === "tool_result") {
      onTrace?.("tool_result", ev);
    } else if (ev.type === "rationale") {
      onTrace?.("rationale", ev);
    } else if (ev.type === "error") {
      throw new Error(ev.message);
    }
  }
  if (!acc.trim()) throw new Error("Agent returned no text — likely the 5-min runtime cap was hit. Try a simpler script.");
  const raw = extractPlan(acc);
  if (!raw) throw new Error(`Agent didn't return a parseable <plan>JSON</plan> block.\n\n${acc.slice(0, 600)}`);
  const clean = sanitizePlan(raw);
  if (!clean.scenes.length) {
    throw new Error("Agent returned a plan but every clip had an invalid asset_id or out-of-range timecode. The player would have been empty.");
  }
  return clean;
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
  const renderPollRef = useRef<number | null>(null);
  const [history, setHistory] = useState<RoughCutHistoryEntry[]>([]);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);

  // Load history on mount.
  useEffect(() => { setHistory(loadHistory()); }, []);

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

  const generate = async () => {
    if (!ks || !script.trim()) return;
    setBusy(true); setErr(null); setPlan(null); setElapsed(0);
    setRender(null); setRenderErr(null);
    if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }
    try {
      const parsed = await runAgentRoughCut(ks._id, script);
      setPlan(parsed);
      const saved = saveEntry({
        title: parsed.title || "Untitled",
        script,
        fps,
        plan: parsed,
        ks_id: ks._id,
        ks_name: ks.name,
      });
      setActiveEntryId(saved.id);
      setHistory(loadHistory());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const restoreEntry = (entry: RoughCutHistoryEntry) => {
    setScript(entry.script);
    setFps(entry.fps);
    setActiveEntryId(entry.id);
    setErr(null);
    setRenderErr(null);
    setPlan(entry.plan);
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
    setHistory(loadHistory());
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
    if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }
    try {
      const job = await startStitch(plan);
      setRender(job);
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
              setHistory(loadHistory());
            }
          }
        } catch (e) {
          setRenderErr(String(e));
          if (renderPollRef.current) { clearInterval(renderPollRef.current); renderPollRef.current = null; }
        }
      }, 3000);
    } catch (e) {
      setRenderErr(String(e));
    }
  };

  // Cleanup poll interval on unmount.
  useEffect(() => {
    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  }, []);

  return (
    <div>
      <header className="flex items-baseline justify-between gap-8">
        <div>
          <div className="label">§ Rough Cut</div>
          <p className="font-display text-4xl mt-1 leading-tight">
            Script → assembled timeline · <span style={{ color: "var(--color-cue)" }}>EDL export</span>
          </p>
          <p className="text-sm mt-2 max-w-2xl" style={{ color: "var(--color-ink-soft)" }}>
            Paste a script, treatment, or scene outline. The reasoning layer reads the dailies in
            the active knowledge base and assembles a rough cut against your structure.
            Export as a CMX-3600 EDL — opens in Premiere, Resolve, FCPX, AVID.
          </p>
        </div>
        <Pill label="Frame rate" value={String(fps)} options={DEFAULT_FPS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))} onChange={(v) => setFps(Number(v))} />
      </header>

      <div className="rule mt-4 mb-6" />

      <HistoryStrip
        entries={history}
        activeId={activeEntryId}
        onRestore={restoreEntry}
        onDelete={removeEntry}
      />

      <div className="grid lg:grid-cols-[1fr_1.4fr] gap-12">
        {/* LEFT: script input */}
        <section>
          <div className="label">§ I · Script</div>
          <div className="rule mt-3 mb-4" />
          <textarea
            className="bg-transparent border w-full p-4 outline-none text-sm leading-relaxed font-mono"
            style={{ borderColor: "var(--color-rule)", minHeight: "60vh" }}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Paste a script, treatment, or scene-by-scene outline…"
          />
          <div className="flex items-center justify-between mt-4">
            <div className="label" style={{ color: "var(--color-ink-faint)" }}>
              {script.length.toLocaleString()} chars · free-form prose, fountain, or outline
            </div>
            <button
              className="btn btn-cue"
              onClick={generate}
              disabled={busy || !ks || !script.trim()}
            >
              {busy ? `assembling… ${elapsed}s` : "assemble rough cut →"}
            </button>
          </div>
          {err && (
            <pre className="font-mono text-xs mt-4 p-3 whitespace-pre-wrap" style={{ background: "var(--color-surface)", color: "var(--color-status-failed)" }}>{err}</pre>
          )}
        </section>

        {/* RIGHT: timeline */}
        <section>
          <div className="flex items-baseline justify-between">
            <div>
              <div className="label">§ II · Timeline · <span style={{ color: "var(--color-cue)" }}>AgentCore</span></div>
              {plan && (
                <p className="font-display text-2xl mt-1" style={{ fontVariationSettings: '"opsz" 144, "wght" 600' }}>
                  "{plan.title || "Rough Cut"}"
                </p>
              )}
            </div>
            {plan && (
              <div className="text-right">
                <div className="font-mono text-2xl" style={{ color: "var(--color-cue)" }}>{fmtDuration(totalSec)}</div>
                <div className="label">{plan.scenes.length} scenes · {clipCount} clips</div>
              </div>
            )}
          </div>
          <div className="rule mt-3 mb-4" />

          {!plan && !busy && (
            <p className="text-sm" style={{ color: "var(--color-ink-faint)" }}>
              Paste your script and click <span className="font-mono">assemble rough cut →</span>.
              The cut will appear here scene by scene.
            </p>
          )}

          {busy && (
            <p className="caret font-display text-2xl" style={{ color: "var(--color-ink-soft)" }}>
              Agent reasoning · {elapsed}s
            </p>
          )}

          {plan && (
            <>
              <div className="flex items-center gap-3 mb-2 flex-wrap">
                <button className="btn" onClick={downloadEDL}>Export EDL ({fps} fps) ↓</button>
                <button
                  className="btn btn-cue"
                  onClick={renderPreview}
                  disabled={!!render && render.status !== "ERROR" && render.status !== "CANCELED" && render.status !== "COMPLETE"}
                >
                  {render?.status === "PROGRESSING" || render?.status === "SUBMITTED"
                    ? `rendering… ${render.percent || 0}%`
                    : render?.status === "COMPLETE"
                      ? "re-render preview →"
                      : "Render preview · MediaConvert →"}
                </button>
                {render?.status === "COMPLETE" && (
                  <a className="label hover:text-[var(--color-cue)]" href={render.output_url} target="_blank" rel="noreferrer">
                    open MP4 in new tab ↗
                  </a>
                )}
              </div>
              <RenderPanel render={render} err={renderErr} />
              <div className="mb-6" />

              {/* Back-to-back HLS preview — instant, no MediaConvert stitch. */}
              <div className="mb-6">
                <ChannelPlayer
                  channel={planToChannel(plan, "agent", assetCache)}
                  autoplay={false}
                  loop={false}
                />
              </div>

              {plan.notes && (
                <p className="text-sm italic mb-6 max-w-2xl" style={{ color: "var(--color-ink-soft)" }}>
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
            </>
          )}
        </section>
      </div>
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
  const thumb = asset?.thumbnail?.representative_url;
  const [altsOpen, setAltsOpen] = useState(false);
  const alts = clip.alternatives || [];
  const hasAlts = alts.length > 0;
  return (
    <li className="clip-card p-3">
      <div
        className="grid grid-cols-[64px_1fr_auto] gap-4 items-center cursor-pointer"
        onClick={() => setGlobal({ activeAssetId: clip.video_reference })}
      >
      <div
        className="aspect-video rounded-sm"
        style={{
          background: thumb ? `url(${thumb}) center/cover no-repeat` : "var(--color-surface-2)",
          height: 36,
        }}
      />
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
            {altsOpen ? "▾" : "▸"} {alts.length} alternate{alts.length === 1 ? "" : "s"} · marengo-ranked
          </button>

          {altsOpen && (
            <ul className="mt-2 space-y-1.5">
              {alts.map((alt, k) => {
                const altAsset = assetCache?.[alt.video_reference];
                const altThumb = altAsset?.thumbnail?.representative_url;
                const altDur = Math.max(parseTime(alt.end_time) - parseTime(alt.start_time), 0);
                return (
                  <li
                    key={k}
                    className="grid grid-cols-[48px_1fr_auto_auto] gap-3 items-center px-2 py-1.5 rounded-sm"
                    style={{ background: "var(--color-surface)" }}
                  >
                    <div
                      className="aspect-video rounded-sm"
                      style={{
                        background: altThumb ? `url(${altThumb}) center/cover no-repeat` : "var(--color-surface-2)",
                        height: 28,
                      }}
                    />
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
  label, value, options, onChange,
}: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.value === value);
  return (
    <div className="relative">
      <div className="label">{label}</div>
      <button
        className="font-display text-lg mt-1 flex items-baseline gap-2 hover:text-[var(--color-cue)]"
        onClick={() => setOpen((v) => !v)}
      >
        {cur?.label || value}
        <span className="font-mono text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 py-2 min-w-[280px]" style={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)" }}>
          {options.map((o) => (
            <button
              key={o.value}
              className="block w-full text-left px-4 py-2 font-display text-base hover:text-[var(--color-cue)] hover:bg-[var(--color-surface-2)]"
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
