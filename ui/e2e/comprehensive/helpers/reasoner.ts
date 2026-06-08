// Bedrock-Claude "reasoner" — grades rough-cut outputs for semantic quality
// in addition to the structural checks (duration band, adjacency, scene
// count) that Playwright asserts directly. The test sends Claude:
//   - the brief
//   - the emitted plan JSON
//   - the KS context (name + description)
// Claude returns a structured verdict the test can assert on.
//
// Uses the same AWS credentials the operator already has loaded
// (AWS_PROFILE=TLSolProd works because the SDK reads ~/.aws/config).

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID =
  process.env.E2E_REASONER_MODEL_ID || "us.anthropic.claude-sonnet-4-6";

const client = new BedrockRuntimeClient({ region: REGION });

export type ReasonerVerdict = {
  /** Hard pass / fail. False => the test should fail. */
  pass: boolean;
  /** 0-10 quality score with rationale. Mainly for debugging when pass=true
   *  is borderline. */
  score: number;
  /** One- to two-sentence rationale Claude wrote about the plan. */
  rationale: string;
  /** List of concrete issues Claude flagged. Empty when pass=true. */
  issues: string[];
};

export type GradeInput = {
  /** The producer's brief (text the user typed). */
  brief: string;
  /** The full plan JSON the agent emitted, parsed. */
  plan: unknown;
  /** Knowledge store metadata for context. */
  ks: { id: string; name?: string; description?: string };
  /** Optional explicit duration target the test parsed from the brief
   *  (seconds). When provided, the reasoner explicitly checks it. */
  durationTargetSec?: number;
  /** Cut type the agent classified into (sizzle / narrative / …). The
   *  reasoner uses this to pick the right quality criteria. */
  cutType?: string;
};

/** Strip ```json fences and `<plan>` tags so we always send Claude pure JSON. */
function unwrapPlan(plan: unknown): string {
  if (typeof plan !== "string") return JSON.stringify(plan, null, 2);
  let p = plan.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(p);
  if (fence) p = fence[1].trim();
  const planTag = /<plan>([\s\S]*?)<\/plan>/i.exec(p);
  if (planTag) p = planTag[1].trim();
  return p;
}

const SYSTEM = `You are a senior creative-editorial reviewer assessing whether a Rough Cut plan satisfies a producer's brief.

You will receive:
- The brief (what the producer asked for, in their own words).
- The emitted plan JSON (scenes, primary clips, alternates, total duration).
- The knowledge store name/description (corpus context).
- Optionally a parsed duration target and the agent's classified cut type.

You will output a SINGLE JSON object — no preamble, no fences:

{
  "pass": true | false,
  "score": 0-10,
  "rationale": "1-2 sentences on why",
  "issues": ["concrete problem 1", "concrete problem 2", ...]
}

Pass criteria (ALL must hold for pass=true):
1. The plan obviously responds to the brief's INTENT (right cut type, right energy/pacing implied by the brief).
2. Scene names + roles + take_notes read as if a human editor wrote them — specific, content-grounded, not generic boilerplate.
3. The plan respects its declared cut type's pacing (sizzle = fast cuts under 8s; rough_cut = 10-30s beats; etc).
4. If a duration target was provided, the plan's sum of (end_time - start_time) across primaries lands within ±10% or ±3s of target.
5. No two consecutive scenes from the same asset_id for sizzle / narrative / montage / highlight / rough_cut types.
6. Asset diversity reasonable for the cut type (a 6-scene sizzle should use ≥4 distinct asset_ids).

Score interpretation:
- 9-10: exceptional, ship-ready
- 7-8: solid, would land with the producer
- 5-6: serviceable but has at least one obvious editorial weakness
- <5: doesn't fit the brief

Be terse. No prose outside the JSON.`;

export async function gradeRoughCut(input: GradeInput): Promise<ReasonerVerdict> {
  const planJson = unwrapPlan(input.plan);

  const userParts: string[] = [
    `# Brief\n${input.brief.trim()}`,
    `# KS\nid: ${input.ks.id}\nname: ${input.ks.name ?? ""}\ndescription: ${input.ks.description ?? ""}`,
  ];
  if (input.durationTargetSec) {
    userParts.push(`# Duration target (parsed)\n${input.durationTargetSec} seconds`);
  }
  if (input.cutType) {
    userParts.push(`# Classified cut type\n${input.cutType}`);
  }
  userParts.push(`# Emitted plan JSON\n${planJson}`);

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 800,
    temperature: 0.1,
    system: SYSTEM,
    messages: [{ role: "user", content: userParts.join("\n\n") }],
  };

  const resp = await client.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(body),
    }),
  );
  const decoded = JSON.parse(new TextDecoder().decode(resp.body));
  // Bedrock Claude response format: { content: [{ type: "text", text: "..." }] }
  const text: string =
    decoded?.content?.find?.((c: any) => c?.type === "text")?.text ??
    decoded?.completion ??
    "";
  return parseVerdict(text);
}

function parseVerdict(text: string): ReasonerVerdict {
  const trimmed = text.trim();
  // Tolerate ```json fences just in case.
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const raw = fence ? fence[1] : trimmed;
  // Find the first JSON object — robust to a stray sentence around it.
  const braceMatch = /\{[\s\S]*\}/.exec(raw);
  if (!braceMatch) {
    throw new Error(`reasoner returned non-JSON: ${text.slice(0, 200)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(braceMatch[0]);
  } catch (e) {
    throw new Error(`reasoner JSON parse failed: ${(e as Error).message}; payload: ${braceMatch[0].slice(0, 200)}`);
  }
  return {
    pass: Boolean(parsed.pass),
    score: Number(parsed.score ?? 0),
    rationale: String(parsed.rationale ?? ""),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
  };
}
