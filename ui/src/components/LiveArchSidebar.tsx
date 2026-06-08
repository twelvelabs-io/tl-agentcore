// Compact live architecture rail for the studio's right pane (~320px).
//
// Vertical stack: spine (browser → runtime), 4 tool lanes, then a muted
// "offline" section listing the ingest scripts + entity-Re-ID Step Functions
// + SageMaker Async endpoint. The live half lights up per agent tool call;
// the offline half is always visible but never highlights (those paths
// only fire from operator CLI, not via the agent).

import { motion } from "motion/react";
import { useStore } from "../lib/store";
import { type NodeId } from "./LiveArchDiagram";

type Activity = "idle" | "active" | "recent";

// ── Spine: browser → CloudFront → API Gateway → λs → AgentCore Runtime ──
const SPINE: { id: NodeId; title: string; sub?: string; tag?: string }[] = [
  { id: "browser",     title: "Browser",     sub: "wss + REST · Cognito JWT", tag: "client" },
  { id: "cloudfront",  title: "CloudFront",  sub: "edge · pass-through",      tag: "edge" },
  { id: "apigw",       title: "API Gateway", sub: "WS /live + HTTP /tl/* /kb-graph", tag: "ingress" },
];

// Lambdas behind the API gateway; rendered as a mini-cluster because they
// fan out from the gateway.
const LAMBDAS: { id: NodeId; title: string; sub: string }[] = [
  { id: "kb_admin_lambda",         title: "kb_admin λ",          sub: "http /kb/* · DDB KS + assets CRUD" },
  { id: "kb_graph_lambda",         title: "kb_graph λ",          sub: "http /kb-graph · kb_cache DDB" },
  { id: "embed_clip_start_lambda", title: "upload + embed λ",    sub: "http /upload/* · MediaConvert + Marengo" },
];

const RUNTIME: { id: NodeId; title: string; sub?: string; tag?: string } = {
  id: "runtime", title: "AgentCore Runtime",
  sub: "Strands · Sonnet 4.6 · Graviton (arm64)",
  tag: "orchestrator",
};

// ── Four tool lanes (tier 0/1/2/3) ───────────────────────────────────────
const TOOL_BRANCHES: {
  group: string;
  label: string;
  tool: NodeId;
  store: NodeId;
  storeLabel: string;
  storeSub: string;
  hint: string;
  tier: string;
}[] = [
  {
    group: "cache",
    label: "kb_cache tools",
    tool: "cache_tool",
    store: "ddb_cache",
    storeLabel: "DynamoDB",
    storeSub: "kb_cache · knowledge_stores · assets · rights · audiences",
    hint: "overview · assets · entities · events · rights · audiences",
    tier: "tier 1 · cache",
  },
  {
    group: "vector",
    label: "vector_search · find_entity_by_image",
    tool: "vector_search_tool",
    store: "s3vectors_index",
    storeLabel: "S3 Vectors",
    storeSub: "clips · entity-thumbs · entity-patches",
    hint: "Bedrock Marengo / Titan → ANN over per-clip + per-patch embeddings",
    tier: "tier 0 · retrieval",
  },
  {
    group: "pegasus",
    label: "pegasus_analyze",
    tool: "pegasus_tool",
    store: "clips_bucket",
    storeLabel: "S3 · clips bucket",
    storeSub: "Bedrock Pegasus 1.2 reads s3Location",
    hint: "On-demand take-note when a clip needs prose grounding",
    tier: "tier 2 · analyze",
  },
];

// ── Offline section: scripts + Step Functions + SageMaker Async (muted) ──
const OFFLINE_INGEST: { title: string; sub: string }[] = [
  { title: "upload + MediaConvert",  sub: "Browser PUT → S3 → HLS bundle in s3://clips/hls/" },
  { title: "ingest_kb_cache",        sub: "→ Pegasus → DDB profiles + entities" },
  { title: "ingest_vectors",         sub: "→ Marengo (Bedrock async) → S3 Vectors" },
  { title: "ingest_entity_thumbs",   sub: "→ ffmpeg + Titan → S3 Vectors entity-thumbs" },
  { title: "build_event_groups",     sub: "→ Bedrock Claude → DDB EVENT#" },
  { title: "seed_rights · seed_audiences", sub: "→ DDB rights / audiences" },
];

const OFFLINE_REID: { title: string; sub: string; tag?: string }[] = [
  { title: "Step Functions",            sub: "ListAssets → Map(InvokeAsync · EmbedPatches)", tag: "orchestrator" },
  { title: "SageMaker Async Endpoint",  sub: "gdino (HF) · DeepSORT · Re-ID Triton · ml.g5.xlarge", tag: "autoscale 0..2" },
  { title: "entity_reid_invoke_async λ", sub: "presign · InvokeEndpointAsync · poll S3" },
  { title: "entity_reid_embed_patches λ", sub: "patch_b64 → Titan → S3 Vectors entity-patches" },
  { title: "CodeBuild · ECR",            sub: "builds + pushes gdino + agent images", tag: "image build" },
  { title: "Bedrock foundation models",  sub: "Marengo · Pegasus · Titan · Claude (haiku · sonnet)", tag: "inference" },
];

// ─── Component ──────────────────────────────────────────────────────────────
export function LiveArchSidebar({
  activeNode,
  history,
  sessionId,
}: {
  activeNode: NodeId | null;
  history: NodeId[];
  sessionId?: string;
}) {
  const ks = useStore((s) => s.ks);
  const stateOf = (id: NodeId): Activity =>
    id === activeNode ? "active" : history.includes(id) ? "recent" : "idle";

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-5 py-4 border-b" style={{ borderColor: "var(--color-rule)" }}>
        <div className="label">§ Live arch</div>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5"
        tabIndex={0}
        role="region"
        aria-label="Live architecture"
      >
        {/* Spine: browser → CloudFront → API Gateway */}
        <div className="space-y-1.5">
          {SPINE.map((n) => (
            <NodePill key={n.id} state={stateOf(n.id)} title={n.title} sub={n.sub} tag={n.tag} />
          ))}
        </div>

        {/* Lambda triple */}
        <div className="space-y-1.5">
          <div className="label" style={{ color: "var(--color-ink-faint)" }}>§ Lambdas</div>
          {LAMBDAS.map((l) => (
            <NodePill key={l.id} state={stateOf(l.id)} title={l.title} sub={l.sub} mono />
          ))}
        </div>

        {/* AgentCore Runtime */}
        <div>
          <NodePill state={stateOf(RUNTIME.id)} title={RUNTIME.title} sub={RUNTIME.sub} tag={RUNTIME.tag} />
        </div>

        {/* 4 tool lanes */}
        <div className="pt-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
          <div className="label mb-3">§ Tool lanes</div>
          <div className="space-y-3">
            {TOOL_BRANCHES.map((b) => (
              <div key={b.group}>
                <div className="text-[9px] font-mono mb-0.5" style={{ color: "var(--color-ink-faint)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  {b.tier}
                </div>
                <NodePill state={stateOf(b.tool)} title={b.label} sub={b.hint} tag="tool" mono />
                <div className="pl-3 pt-1 pb-0.5 text-[10px] font-mono" style={{ color: "var(--color-ink-faint)" }}>↓</div>
                <NodePill state={stateOf(b.store)} title={b.storeLabel} sub={b.storeSub} tag="store" />
              </div>
            ))}
          </div>
        </div>

        {/* Offline / Operator section */}
        <div className="pt-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
          <div className="label mb-2">§ Offline · ingest pipelines</div>
          <div className="space-y-1.5">
            {OFFLINE_INGEST.map((s) => (
              <NodePill key={s.title} state="idle" title={s.title} sub={s.sub} mono muted />
            ))}
          </div>
        </div>

        <div className="pt-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
          <div className="label mb-2">§ Offline · entity Re-ID + image build</div>
          <div className="space-y-1.5">
            {OFFLINE_REID.map((s) => (
              <NodePill key={s.title} state="idle" title={s.title} sub={s.sub} tag={s.tag} muted />
            ))}
          </div>
        </div>

        {/* Session */}
        <div className="pt-2 border-t" style={{ borderColor: "var(--color-rule)" }}>
          <div className="label mb-2">§ Session</div>
          <div className="space-y-2.5">
            <Field label="Knowledge store">{ks?._id || "—"}</Field>
            <Field label="Runtime session">{sessionId || "(new on next turn)"}</Field>
          </div>
        </div>
      </div>
    </div>
  );
}

function NodePill({
  state, title, sub, tag, mono, muted,
}: {
  state: Activity;
  title: string;
  sub?: string;
  tag?: string;
  mono?: boolean;
  muted?: boolean;
}) {
  const isActive = state === "active";
  const isRecent = state === "recent";

  const borderColor = muted ? "color-mix(in oklch, var(--color-rule) 70%, transparent)"
    : isActive ? "var(--color-cue)"
    : isRecent ? "var(--color-cue-deep)"
    : "var(--color-rule)";

  const bg = muted ? "color-mix(in oklch, var(--color-surface) 70%, var(--color-paper))"
    : isActive ? "color-mix(in oklch, var(--color-cue) 14%, var(--color-surface))"
    : isRecent ? "color-mix(in oklch, var(--color-cue-deep) 10%, var(--color-surface))"
    : "var(--color-surface)";

  const titleColor = muted ? "var(--color-ink-soft)" : isActive ? "var(--color-cue)" : "var(--color-ink)";
  const subColor = muted ? "var(--color-ink-faint)" : "var(--color-ink-soft)";

  return (
    <motion.div
      className="px-3 py-1.5 border rounded-[10px]"
      style={{ borderColor, background: bg, opacity: muted ? 0.78 : 1 }}
      animate={isActive ? {
        boxShadow: [
          "0 0 0 0 color-mix(in oklch, var(--color-cue) 25%, transparent)",
          "0 0 0 6px color-mix(in oklch, var(--color-cue) 0%, transparent)",
        ],
      } : { boxShadow: "0 0 0 0 transparent" }}
      transition={isActive ? { duration: 1.4, repeat: Infinity, ease: "easeOut" } : { duration: 0.3 }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4
          className={`text-[13px] leading-tight ${mono ? "font-mono" : "font-display"}`}
          style={{ color: titleColor }}
        >
          {title}
        </h4>
        {tag && (
          <span className="label text-[9px]" style={{ color: "var(--color-ink-faint)" }}>{tag}</span>
        )}
      </div>
      {sub && (
        <div className="text-[10.5px] mt-0.5 leading-snug" style={{ color: subColor }}>{sub}</div>
      )}
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label text-[10px]" style={{ color: "var(--color-ink-faint)" }}>{label}</div>
      <div className="font-mono text-[11px] break-all mt-0.5" style={{ color: "var(--color-ink-soft)" }}>{children}</div>
    </div>
  );
}
