// Distribution-Readiness card — parser + types.
//
// The agent emits `<distribution_card>...</distribution_card>` blocks when
// a user asks a Distribution-Readiness question (see Distribution-Readiness
// mode in agent/tl_agentcore/agent.py SYSTEM_PROMPT). Shape mirrors the
// Rough Cut `<plan>` block but encodes "can I ship X to Y, and if not,
// what's missing".

export type DistributionBrief = {
  genre: string | null;
  age_band: string | null;
  asset_type: "film" | "series" | "episode" | null;
  asset_id: string | null;
};

export type AudienceCandidate = {
  segment_id: string;
  name: string;
  score: number;
  reasons: string[];
};

export type RightsWindow = {
  region: string;
  window_start: string;
  window_end: string;
  usage_type: string;
};

export type DistributionAsset = {
  asset_id: string;
  title: string;
  windows: RightsWindow[];
  have: string[];
  missing: string[];
  ready: boolean;
  notes: string | null;
};

export type DistributionCard = {
  territory: string;
  as_of: string;
  brief: DistributionBrief;
  audience_fit: {
    candidates: AudienceCandidate[];
    method: string;
  };
  policy: {
    applied_policy: string;
    requirements: string[];
    notes: string | null;
  };
  assets: DistributionAsset[];
  summary: {
    ready_count: number;
    blocked_count: number;
    text: string;
  };
};

const CARD_RE = /<distribution_card>([\s\S]*?)<\/distribution_card>/i;

/** Pull the first `<distribution_card>` block out of a streamed/complete
 *  response. Returns `null` when the block is absent, truncated, or the
 *  JSON doesn't parse. Follows the same forgiving pattern as RoughCut's
 *  `extractPlan`: a mid-stream half-block is treated as "not yet", not an
 *  error. */
export function extractDistributionCard(text: string): DistributionCard | null {
  if (!text) return null;
  const m = text.match(CARD_RE);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DistributionCard;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.territory || !Array.isArray(parsed.assets)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Strip `<distribution_card>...</distribution_card>` blocks from text so
 *  the ResponseMarkdown renderer doesn't paint the raw JSON next to the
 *  rendered card. Mirrors `stripPlanBlocks` in vref.tsx — closed pairs are
 *  removed; a truncated/open block hides everything from the open tag
 *  forward so no JSON leaks mid-stream. */
export function stripDistributionCardBlocks(text: string): string {
  let out = text.replace(/<distribution_card>[\s\S]*?<\/distribution_card>/gi, "");
  const open = out.indexOf("<distribution_card>");
  if (open >= 0) out = out.slice(0, open);
  return out.trim();
}
