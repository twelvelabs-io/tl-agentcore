// Single architecture diagram covering everything we've shipped:
//
//   ── LIVE FLOW (lights up per agent tool call) ──
//     Browser → wss/Bedrock AgentCore (Cognito JWT)
//     Browser → CloudFront → HTTP API → { kb_admin · kb_graph · upload+embed λs }
//     AgentCore Runtime → 3 tool lanes:
//       Tier 1 — kb_cache tools → DynamoDB (kb_cache + knowledge_stores + assets + rights + audiences)
//       Tier 0 — vector_search / find_by_image → S3 Vectors + Rekognition Faces (hybrid)
//       Tier 2 — pegasus_analyze → Bedrock Pegasus → S3 clips bucket
//
//   ── OFFLINE / INGEST FLOW (always visible, never highlights) ──
//     Browser upload → MediaConvert HLS → S3 hls/ bundle
//     Auto-pipeline (S3-triggered) → Bedrock (Marengo · Pegasus · Claude) → DDB + S3 Vectors
//     hls_finalize → index_faces λ → Rekognition Faces collection (per-KS)
//     CodeBuild → ECR (agent image)
//
// No TwelveLabs SaaS calls anywhere — every model runs through Bedrock
// Marketplace under the customer's IAM.

import { motion } from "motion/react";

export type NodeId =
  // Live flow
  | "browser"
  | "cloudfront"
  | "apigw"
  | "kb_admin_lambda"
  | "kb_graph_lambda"
  | "presign_upload_lambda"
  | "embed_clip_start_lambda"
  | "runtime"
  | "gateway"
  | "vector_search_tool"
  | "s3vectors_index"
  | "pegasus_tool"
  | "clips_bucket"
  | "cache_tool"
  | "ddb_cache"
  // Offline flow (never lights up live)
  | "operator_cli"
  | "ingest_kb_cache_script"
  | "ingest_vectors_script"
  | "ingest_entity_thumbs_script"
  | "build_event_groups_script"
  | "step_functions"
  | "mediaconvert"
  | "sagemaker_async"
  | "codebuild"
  | "bedrock_models";

type Activity = "idle" | "active" | "recent";

export function LiveArchDiagram({
  activeNode,
  history = [],
  compact = false,
}: {
  activeNode: NodeId | null;
  history?: NodeId[];
  compact?: boolean;
}) {
  const stateOf = (id: NodeId): Activity => {
    if (id === activeNode) return "active";
    if (history.includes(id)) return "recent";
    return "idle";
  };

  return (
    <div className={compact ? "max-w-3xl mx-auto" : "max-w-5xl mx-auto"}>
      <SectionHeader label="LIVE · agent runtime" />

      <div className={`flex flex-col items-center mx-auto ${compact ? "max-w-md" : "max-w-2xl"}`}>
        <ArchCardInner state={stateOf("browser")}    tag="client"  title="Browser"     sub={compact ? undefined : "React SPA · WebSocket + REST"} />
        <ArchArrow active={activeNode === "cloudfront"} label="wss + https" />
        <ArchCardInner state={stateOf("cloudfront")} tag="edge"    title="CloudFront"  sub={compact ? undefined : "single origin · pass-through"} />
        <ArchArrow active={activeNode === "apigw"} />
        <ArchCardInner state={stateOf("apigw")}      tag="ingress" title="API Gateway" sub={compact ? undefined : "HTTP /kb/* · /upload/* · /kb-graph"} />
      </div>

      {/* Lambda row: kb_admin / kb_graph / upload + embed */}
      <ArchBranch
        cols={[
          activeNode === "kb_admin_lambda",
          activeNode === "kb_graph_lambda",
          activeNode === "presign_upload_lambda" || activeNode === "embed_clip_start_lambda",
        ]}
      />
      <div className="grid grid-cols-3 gap-3 max-w-4xl mx-auto">
        <ArchCardInner compact state={stateOf("kb_admin_lambda")}         tag="http · /kb/*"        title="kb_admin λ"    sub="DDB KS + assets" />
        <ArchCardInner compact state={stateOf("kb_graph_lambda")}         tag="http · /kb-graph"    title="kb_graph λ"    sub="→ kb_cache" />
        <ArchCardInner compact state={stateOf("embed_clip_start_lambda")} tag="http · /upload/*"    title="upload + embed λ" sub="presign · MediaConvert · Marengo" />
      </div>

      <div className={`flex flex-col items-center mx-auto mt-3 ${compact ? "max-w-md" : "max-w-2xl"}`}>
        <ArchArrow active={activeNode === "runtime"} label="wss /ws · Cognito JWT" />
        <ArchCardInner state={stateOf("runtime")} tag="orchestrator" title="AgentCore Runtime" sub="Strands · Sonnet 4.6 · Graviton (arm64)" highlightAlways />
      </div>

      <ArchBranch
        cols={[
          activeNode === "cache_tool" || activeNode === "ddb_cache",
          activeNode === "vector_search_tool" || activeNode === "s3vectors_index",
          activeNode === "pegasus_tool" || activeNode === "clips_bucket",
        ]}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-w-6xl mx-auto">
        <div className="flex flex-col items-center">
          <ArchCardInner compact state={stateOf("cache_tool")} tag="tier 1 · cache" title="kb_cache tools" sub="overview · assets · entities · events · rights · audiences" highlightAlways />
          <ArchArrow active={activeNode === "ddb_cache"} label="GetItem · Query · <10ms" />
          <ArchCardInner compact state={stateOf("ddb_cache")} tag="store" title="DynamoDB" sub="kb_cache · knowledge_stores · assets · rights · audiences" highlightAlways />
        </div>
        <div className="flex flex-col items-center">
          <ArchCardInner compact state={stateOf("vector_search_tool")} tag="tier 0 · retrieval" title="vector_search + find_entity_by_image" sub="Bedrock Marengo / Titan → S3 Vectors" highlightAlways />
          <ArchArrow active={activeNode === "s3vectors_index"} label="QueryVectors · ks_id filter" />
          <ArchCardInner compact state={stateOf("s3vectors_index")} tag="store" title="S3 Vectors" sub="clips · entity-thumbs · entity-patches" highlightAlways />
        </div>
        <div className="flex flex-col items-center">
          <ArchCardInner compact state={stateOf("pegasus_tool")} tag="tier 2 · analyze" title="pegasus_analyze" sub="Bedrock Pegasus 1.2" highlightAlways />
          <ArchArrow active={activeNode === "clips_bucket"} label="reads s3Location" />
          <ArchCardInner compact state={stateOf("clips_bucket")} tag="store" title="S3 · clips bucket" sub="mirrored asset bytes + HLS bundles" highlightAlways />
        </div>
      </div>

      <div className="mt-8">
        <SectionHeader label="OFFLINE · ingest + operator pipelines" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-5xl mx-auto">
          <div className="flex flex-col items-center gap-2">
            <ArchCardInner compact muted state="idle" tag="S3-triggered" title="Auto-pipeline" sub="every upload fires the lambda chain" />
            <DownTick muted />
            <div className="w-full grid grid-cols-1 gap-2">
              <ArchCardInner compact muted state="idle" title="upload + MediaConvert"   sub="Browser PUT → S3 → HLS bundle in s3://clips/hls/" />
              <ArchCardInner compact muted state="idle" title="embed_clip_start λ"      sub="Marengo StartAsyncInvoke + MediaConvert CreateJob" />
              <ArchCardInner compact muted state="idle" title="embed_clip_finalize λ"   sub="Marengo output.json → S3 Vectors clips index" />
              <ArchCardInner compact muted state="idle" title="hls_finalize λ"          sub="flip asset→ready, fire-and-forget index_faces" />
              <ArchCardInner compact muted state="idle" title="asset_profile λ"         sub="Pegasus → DDB ASSET# profile + entities" />
              <ArchCardInner compact muted state="idle" tag="4h cron" title="ks_rollup λ" sub="aggregate ASSET# → OVERVIEW/ENTITY#/EVENT#" />
            </div>
          </div>

          <div className="flex flex-col items-center gap-2">
            <ArchCardInner compact muted state="idle" tag="managed CV" title="Rekognition + Marengo hybrid" sub="primary face match · visual fallback" />
            <DownTick muted />
            <div className="w-full grid grid-cols-1 gap-2">
              <ArchCardInner compact muted state="idle" tag="auto" title="index_faces λ" sub="4 frames/asset → Rekognition IndexFaces" />
              <ArchCardInner compact muted state="idle" title="Rekognition Faces" sub="per-KS collection · SearchFacesByImage at query" />
              <ArchCardInner compact muted state="idle" title="Marengo image-embed" sub="Bedrock StartAsyncInvoke (image) · sha256-cached" />
              <ArchCardInner compact muted state="idle" tag="image build" title="CodeBuild · ECR" sub="builds + pushes agent image" />
              <ArchCardInner compact muted state="idle" tag="Bedrock" title="Foundation models" sub="Marengo · Pegasus · Claude (haiku · sonnet)" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-center mb-3">
      <span className="label" style={{ color: "var(--color-ink-faint)", letterSpacing: "0.12em" }}>{label}</span>
      <div className="mx-auto mt-1 h-px max-w-xs" style={{ background: "var(--color-rule)" }} />
    </div>
  );
}

function ArchCardInner({
  state, tag, title, sub, highlightAlways, compact, muted,
}: {
  state: Activity;
  tag?: string;
  title: string;
  sub?: string;
  highlightAlways?: boolean;
  compact?: boolean;
  muted?: boolean;
}) {
  const isActive = state === "active";
  const isRecent = state === "recent";
  const isHL = highlightAlways && state === "idle";

  const borderColor = muted ? "color-mix(in oklch, var(--color-rule) 80%, transparent)" :
    isActive ? "var(--color-cue)" :
    isRecent ? "color-mix(in oklch, var(--color-cue) 40%, var(--color-rule))" :
    isHL ? "var(--color-cue)" :
    "var(--color-rule)";

  const bgColor =
    muted ? "color-mix(in oklch, var(--color-surface) 70%, var(--color-paper))" :
    isActive ? "rgba(255, 122, 26, 0.14)" :
    isRecent ? "rgba(255, 122, 26, 0.04)" :
    isHL ? "rgba(255, 122, 26, 0.05)" :
    "var(--color-surface)";

  const titleColor =
    muted ? "var(--color-ink-soft)" :
    isActive || isHL ? "var(--color-cue)" :
    "var(--color-ink)";

  const py = compact ? "py-1.5" : "py-2";
  const titleSize = compact ? "text-sm" : "text-base lg:text-lg";

  return (
    <motion.div
      className={`w-full border px-3 ${py}`}
      style={{ borderColor, background: bgColor, opacity: muted ? 0.78 : 1 }}
      animate={isActive ? {
        boxShadow: [
          "0 0 0 0 rgba(255, 122, 26, 0.35)",
          "0 0 0 8px rgba(255, 122, 26, 0)",
        ],
      } : { boxShadow: "0 0 0 0 rgba(255, 122, 26, 0)" }}
      transition={isActive ? { duration: 1.4, repeat: Infinity, ease: "easeOut" } : { duration: 0.3 }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4
          className={`font-display ${titleSize}`}
          style={{ fontVariationSettings: '"opsz" 144, "wght" 600', color: titleColor }}
        >
          {title}
        </h4>
        {tag && (
          <span className="label whitespace-nowrap text-[9px]" style={{ color: muted ? "var(--color-ink-faint)" : (isActive || isHL ? "var(--color-cue)" : "var(--color-ink-faint)") }}>
            {tag}
          </span>
        )}
      </div>
      {sub && (
        <div className="font-mono text-[10px] mt-0.5" style={{ color: muted ? "var(--color-ink-faint)" : "var(--color-ink-soft)" }}>
          {sub}
        </div>
      )}
    </motion.div>
  );
}

function ArchArrow({ active, label }: { active?: boolean; label?: string }) {
  const stroke = active ? "var(--color-cue)" : "var(--color-ink-faint)";
  return (
    <div className="relative h-8 w-full flex justify-center my-1">
      <svg width="20" height="32" viewBox="0 0 20 32" className="overflow-visible" aria-hidden>
        <line
          x1="10" y1="0" x2="10" y2="24"
          stroke={stroke}
          strokeWidth={active ? 1.5 : 1}
          strokeDasharray={active ? "4 3" : undefined}
        >
          {active && (
            <animate attributeName="stroke-dashoffset" from="0" to="-7" dur="0.6s" repeatCount="indefinite" />
          )}
        </line>
        <polygon points="10,32 5,22 15,22" fill={stroke} />
      </svg>
      {label && (
        <span
          className="label absolute"
          style={{
            left: "calc(50% + 14px)",
            top: "50%",
            transform: "translateY(-50%)",
            color: active ? "var(--color-cue)" : "var(--color-ink-faint)",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

function DownTick({ muted }: { muted?: boolean }) {
  const stroke = muted ? "color-mix(in oklch, var(--color-ink-faint) 60%, transparent)" : "var(--color-ink-faint)";
  return (
    <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden>
      <line x1="7" y1="0" x2="7" y2="15" stroke={stroke} strokeWidth="1" />
      <polygon points="7,20 3,13 11,13" fill={stroke} />
    </svg>
  );
}

function ArchBranch({ cols }: { cols: boolean[] }) {
  const baseStroke = "var(--color-ink-faint)";
  const stroke = (on?: boolean) => on ? "var(--color-cue)" : baseStroke;
  const dash   = (on?: boolean) => on ? "4 3" : undefined;
  const width  = (on?: boolean) => on ? 1.5 : 1;
  const anyActive = cols.some(Boolean);

  const W = 1100, H = 64, spineY = 16, dropY = 56;
  const center = W / 2;
  const padX = 80;
  const colXs = cols.length === 1
    ? [center]
    : cols.map((_, i) => padX + (W - padX * 2) * (i / (cols.length - 1)));

  const spineSegments = colXs.slice(0, -1).map((x, i) => ({
    x1: x, x2: colXs[i + 1],
    active: cols[i] || cols[i + 1],
  }));

  return (
    <div className="flex justify-center my-3 overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible" aria-hidden style={{ minWidth: 640 }}>
        <line x1={center} y1="0" x2={center} y2={spineY} stroke={stroke(anyActive)} strokeWidth="1" />
        {spineSegments.map((s, i) => (
          <line key={i} x1={s.x1} y1={spineY} x2={s.x2} y2={spineY}
                stroke={stroke(s.active)}
                strokeWidth={width(s.active)}
                strokeDasharray={dash(s.active)} />
        ))}
        {colXs.map((x, i) => (
          <g key={i}>
            <line x1={x} y1={spineY} x2={x} y2={dropY}
                  stroke={stroke(cols[i])}
                  strokeWidth={width(cols[i])}
                  strokeDasharray={dash(cols[i])} />
            <polygon points={`${x},${H} ${x - 5},${dropY - 4} ${x + 5},${dropY - 4}`}
                     fill={stroke(cols[i])} />
          </g>
        ))}
      </svg>
    </div>
  );
}

// ─── Tool → lane classification ─────────────────────────────────────────────
const CACHE_TOOLS = new Set([
  "get_kb_overview", "list_kb_assets", "lookup_asset_profile",
  "lookup_rights", "list_audiences", "lookup_audience",
  "find_cached_entity_appearances", "list_cached_entities",
  "list_kb_events", "lookup_event",
]);

export function nodeForEvent(ev: { type: string; tool?: string }): NodeId | null {
  if (ev.type === "session") return "runtime";
  if (ev.type === "tool_call") {
    const t = ev.tool || "";
    if (t === "vector_search" || t === "find_by_image") return "vector_search_tool";
    if (t === "pegasus_analyze") return "pegasus_tool";
    if (CACHE_TOOLS.has(t)) return "cache_tool";
    return "runtime";
  }
  if (ev.type === "tool_result") return "runtime";
  if (ev.type === "rationale") return "runtime";
  if (ev.type === "text_delta") return "runtime";
  if (ev.type === "done") return "browser";
  return null;
}

export function downstreamFor(toolName: string | undefined): NodeId | null {
  if (!toolName) return null;
  if (toolName === "vector_search" || toolName === "find_by_image") return "s3vectors_index";
  if (toolName === "pegasus_analyze") return "clips_bucket";
  if (CACHE_TOOLS.has(toolName))      return "ddb_cache";
  return null;
}
