// Reusable architecture diagram that lights up nodes as a request flows.
// Driven by an `activeNode` prop wired to streaming agent trace events.
//
// Node IDs:
//   browser → cloudfront → apigw → chat_lambda → runtime
//                                                  │
//                                              gateway (when MCP path)
//                                                  ↓
//                                        marengo + pegasus / kb_cache
//
// Mapping (handled by callers):
//   tool_call marengo/pegasus → "marengo_pegasus_tools" (then tl_*)
//   tool_call kb_cache_*      → "kb_cache_tools" (then dynamodb_kb_cache)
//   tool_result / rationale   → "runtime"
//   text_delta                → "runtime"
//   done                      → "browser" then null
//   error                     → null (caller handles error styling separately)

import { motion } from "motion/react";

export type NodeId =
  | "browser"
  | "cloudfront"
  | "apigw"
  | "chat_lambda"
  | "runtime"
  | "gateway"
  | "lookup_rights"
  | "audience_tools"
  | "marengo_pegasus_tools"
  | "kb_cache_tools"
  | "tl_marengo"
  | "tl_pegasus"
  | "dynamodb_rights"
  | "dynamodb_audiences"
  | "dynamodb_kb_cache";

type Activity = "idle" | "active" | "recent";

export function LiveArchDiagram({
  activeNode,
  history = [],
  compact = false,
  hideStudioPath = false,
}: {
  activeNode: NodeId | null;
  history?: NodeId[];
  compact?: boolean;
  /** Hide the Marengo + Pegasus column. */
  hideStudioPath?: boolean;
}) {
  const stateOf = (id: NodeId): Activity => {
    if (id === activeNode) return "active";
    if (history.includes(id)) return "recent";
    return "idle";
  };

  return (
    <div className={compact ? "max-w-3xl mx-auto" : "max-w-4xl mx-auto"}>
      <div className={`flex flex-col items-center mx-auto ${compact ? "max-w-md" : "max-w-2xl"}`}>
        <ArchCard
          state={stateOf("browser")}
          tag="client"
          title="Browser"
          sub={compact ? undefined : "React SPA · WebSocket"}
        />
        <ArchArrow active={activeNode === "cloudfront"} label="wss://…/live" />
        <ArchCard
          state={stateOf("cloudfront")}
          tag="edge"
          title="CloudFront"
          sub={compact ? undefined : "single origin · pass-through"}
        />
        <ArchArrow active={activeNode === "apigw"} />
        <ArchCard
          state={stateOf("apigw")}
          tag="ingress"
          title="API Gateway"
          sub={compact ? undefined : "WebSocket · $default"}
        />
        <ArchArrow active={activeNode === "chat_lambda"} label="invoke" />
        <ArchCard
          state={stateOf("chat_lambda")}
          tag="service"
          title="Chat λ"
          sub={compact ? undefined : "async self-invoke for long runs"}
        />
        <ArchArrow active={activeNode === "runtime"} label="InvokeAgentRuntime" />
        <ArchCard
          state={stateOf("runtime")}
          tag="orchestrator"
          title="AgentCore Runtime"
          sub="Strands · Sonnet 4.6 · Graviton"
          highlightAlways
        />
        <ArchArrow active={activeNode === "gateway"} label="MCP · Bearer JWT" />
        <ArchCard
          state={stateOf("gateway")}
          tag="tool catalog"
          title="AgentCore Gateway"
          sub="MCP · Cognito JWT auth"
          highlightAlways
        />
      </div>

      <ArchBranch
        cols={[
          activeNode === "kb_cache_tools" || activeNode === "dynamodb_kb_cache",
          ...(hideStudioPath ? [] : [activeNode === "marengo_pegasus_tools" || activeNode === "tl_marengo" || activeNode === "tl_pegasus"]),
          activeNode === "lookup_rights" || activeNode === "dynamodb_rights",
          activeNode === "audience_tools" || activeNode === "dynamodb_audiences",
        ]}
      />

      <div className={`grid grid-cols-1 ${gridColsClass(hideStudioPath)} gap-4 max-w-6xl mx-auto`}>
        <div className="flex flex-col items-center">
          <ArchCard
            state={stateOf("kb_cache_tools")}
            tag="cache · in-proc"
            title="kb_cache tools"
            sub="overview · list · profile"
            highlightAlways
          />
          <ArchArrow active={activeNode === "dynamodb_kb_cache"} label="Query / GetItem" />
          <ArchCard
            state={stateOf("dynamodb_kb_cache")}
            tag="store"
            title="DynamoDB"
            sub="kb_cache · per-asset profiles"
            highlightAlways
          />
        </div>
        {!hideStudioPath && (
          <div className="flex flex-col items-center">
            <ArchCard
              state={stateOf("marengo_pegasus_tools")}
              tag="tools · in-proc"
              title="marengo + pegasus"
              sub="search + analyze"
            />
            <ArchArrow
              active={activeNode === "tl_marengo" || activeNode === "tl_pegasus"}
              label="x-api-key"
            />
            <ArchCard
              state={
                activeNode === "tl_marengo" ? "active" :
                activeNode === "tl_pegasus" ? "active" :
                stateOf("tl_marengo")
              }
              tag="external"
              title={
                activeNode === "tl_pegasus" ? "TL Pegasus" :
                activeNode === "tl_marengo" ? "TL Marengo" :
                "TL Marengo + Pegasus"
              }
              sub={
                activeNode === "tl_pegasus" ? "/v1.3/analyze" :
                activeNode === "tl_marengo" ? "/v1.3/search" :
                "/v1.3/{search,analyze}"
              }
            />
          </div>
        )}
        <div className="flex flex-col items-center">
          <ArchCard
            state={stateOf("lookup_rights")}
            tag="tool · λ"
            title="lookup_rights"
            sub="via Gateway · MCP"
          />
          <ArchArrow active={activeNode === "dynamodb_rights"} label="GetItem" />
          <ArchCard
            state={stateOf("dynamodb_rights")}
            tag="store"
            title="DynamoDB"
            sub="rights table"
          />
        </div>
        <div className="flex flex-col items-center">
          <ArchCard
            state={stateOf("audience_tools")}
            tag="tools · in-proc"
            title="audience tools"
            sub="list + lookup"
          />
          <ArchArrow active={activeNode === "dynamodb_audiences"} label="Scan / GetItem" />
          <ArchCard
            state={stateOf("dynamodb_audiences")}
            tag="store"
            title="DynamoDB"
            sub="audiences table"
          />
        </div>
      </div>
    </div>
  );
}

function ArchCard({
  state, tag, title, sub, highlightAlways,
}: {
  state: Activity;
  tag?: string;
  title: string;
  sub?: string;
  highlightAlways?: boolean;
}) {
  const isActive = state === "active";
  const isRecent = state === "recent";
  const isHL = highlightAlways && state === "idle";

  // Color decisions
  const borderColor =
    isActive ? "var(--color-cue)" :
    isRecent ? "color-mix(in oklch, var(--color-cue) 40%, var(--color-rule))" :
    isHL ? "var(--color-cue)" :
    "var(--color-rule)";

  const bgColor =
    isActive ? "rgba(255, 122, 26, 0.14)" :
    isRecent ? "rgba(255, 122, 26, 0.04)" :
    isHL ? "rgba(255, 122, 26, 0.05)" :
    "var(--color-surface)";

  const titleColor =
    isActive || isHL ? "var(--color-cue)" :
    isRecent ? "var(--color-ink)" :
    "var(--color-ink)";

  return (
    <motion.div
      className="w-full border px-4 py-2"
      style={{ borderColor, background: bgColor }}
      animate={isActive ? {
        boxShadow: [
          "0 0 0 0 rgba(255, 122, 26, 0.35)",
          "0 0 0 8px rgba(255, 122, 26, 0)",
        ],
      } : { boxShadow: "0 0 0 0 rgba(255, 122, 26, 0)" }}
      transition={isActive ? { duration: 1.4, repeat: Infinity, ease: "easeOut" } : { duration: 0.3 }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4
          className="font-display text-base lg:text-lg"
          style={{ fontVariationSettings: '"opsz" 144, "wght" 600', color: titleColor }}
        >
          {title}
        </h4>
        {tag && (
          <span className="label whitespace-nowrap" style={{ color: isActive || isHL ? "var(--color-cue)" : "var(--color-ink-faint)" }}>
            {tag}
          </span>
        )}
      </div>
      {sub && (
        <div className="font-mono text-[10px] mt-0.5" style={{ color: "var(--color-ink-soft)" }}>
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

function ArchBranch({ cols }: { cols: boolean[] }) {
  const baseStroke = "var(--color-ink-faint)";
  const stroke = (on?: boolean) => on ? "var(--color-cue)" : baseStroke;
  const dash   = (on?: boolean) => on ? "4 3" : undefined;
  const width  = (on?: boolean) => on ? 1.5 : 1;
  const anyActive = cols.some(Boolean);

  // N-way fork: vertical stem from center down to spine, spine across N columns,
  // vertical drop into each column.
  const W = 1100, H = 64, spineY = 16, dropY = 56;
  const center = W / 2;
  const padX = 80;
  const colXs = cols.length === 1
    ? [center]
    : cols.map((_, i) => padX + (W - padX * 2) * (i / (cols.length - 1)));

  // For each pair of adjacent column xs, draw a spine segment whose color
  // reflects whichever side is active.
  const spineSegments = colXs.slice(0, -1).map((x, i) => ({
    x1: x, x2: colXs[i + 1],
    active: cols[i] || cols[i + 1],
  }));

  return (
    <div className="flex justify-center my-3 overflow-x-auto">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible" aria-hidden style={{ minWidth: 640 }}>
        {/* center stem */}
        <line x1={center} y1="0" x2={center} y2={spineY} stroke={stroke(anyActive)} strokeWidth="1" />
        {/* spine */}
        {spineSegments.map((s, i) => (
          <line
            key={i}
            x1={s.x1} y1={spineY} x2={s.x2} y2={spineY}
            stroke={stroke(s.active)}
            strokeWidth={width(s.active)}
            strokeDasharray={dash(s.active)}
          />
        ))}
        {/* drops + arrowheads */}
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

// Up to 4 default columns: kb_cache · marengo+pegasus · rights · audiences.
// hideStudio drops one. Tailwind needs literal class names so we resolve to
// a fixed string here rather than building it dynamically.
function gridColsClass(hideStudio: boolean): string {
  const cols = 4 - (hideStudio ? 1 : 0);
  if (cols === 4) return "md:grid-cols-4";
  if (cols === 3) return "md:grid-cols-3";
  return "md:grid-cols-2";
}

// --- helper for callers: derive the activeNode from a streamed agent event ---
export function nodeForEvent(ev: { type: string; tool?: string }): NodeId | null {
  if (ev.type === "session") return "runtime";
  if (ev.type === "tool_call") {
    const t = ev.tool || "";
    if (t === "lookup_rights" || t === "lookup-rights") return "lookup_rights";
    if (t === "list_audiences" || t === "lookup_audience") return "audience_tools";
    if (t === "marengo_search" || t === "pegasus_analyze" || t === "list_tl_indexes")
      return "marengo_pegasus_tools";
    if (t === "get_kb_overview" || t === "list_kb_assets" || t === "lookup_asset_profile")
      return "kb_cache_tools";
    return "runtime";
  }
  if (ev.type === "tool_result") return "runtime";
  if (ev.type === "rationale") return "runtime";
  if (ev.type === "text_delta") return "runtime";
  if (ev.type === "done") return "browser";
  return null;
}

// --- helper: which downstream node a tool call bounces to after ~400ms ---
export function downstreamFor(toolName: string | undefined): NodeId | null {
  if (!toolName) return null;
  if (toolName === "marengo_search" || toolName === "list_tl_indexes") return "tl_marengo";
  if (toolName === "pegasus_analyze") return "tl_pegasus";
  if (toolName === "get_kb_overview" || toolName === "list_kb_assets" || toolName === "lookup_asset_profile")
    return "dynamodb_kb_cache";
  if (toolName.includes("rights")) return "dynamodb_rights";
  if (toolName.includes("audience")) return "dynamodb_audiences";
  return null;
}
