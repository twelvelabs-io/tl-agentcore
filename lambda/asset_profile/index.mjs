// asset_profile — S3-triggered Pegasus profile + kb_cache write.
//
// Trigger: S3 ObjectCreated on s3://<clips>/clips/<asset_id>.mp4
//
// Steps:
//   1. Read the assets DDB row to recover knowledge_store_id + filename.
//   2. Call Bedrock Pegasus 1.2 with the structured PROFILE_PROMPT against
//      the s3Location.
//   3. Parse the JSON profile, write kb_cache row pk=ks#<id> sk=ASSET#<aid>.
//
// Idempotent: re-firing on the same object overwrites the same row. The
// ks_rollup lambda runs periodically to fold all ASSET# rows into the
// cross-asset ENTITY# / OVERVIEW / EVENT# rows.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const br = new BedrockRuntimeClient({});
const ddb = new DynamoDBClient({});
const lam = new LambdaClient({});

// Per-deployment override of PROFILE_PROMPT, written by the settings lambda.
// Cached for the lifetime of a warm container (Pegasus is slow enough that a
// few-minute cache miss after a save is fine — operators see the new prompt
// take effect on the next ingest wave). Set OVERRIDE_TTL_MS=0 to disable.
const OVERRIDE_TTL_MS = Number(process.env.PROFILE_PROMPT_TTL_MS ?? 300_000);
let _profilePromptCache = { value: null, expiresAt: 0 };
async function loadProfilePrompt() {
  if (Date.now() < _profilePromptCache.expiresAt) return _profilePromptCache.value;
  try {
    const out = await ddb.send(new GetItemCommand({
      TableName: KB_CACHE_TABLE,
      Key: { pk: { S: "settings#prompts" }, sk: { S: "pegasus_profile" } },
    }));
    const override = out?.Item?.text?.S;
    const value = (typeof override === "string" && override.trim()) ? override : PROFILE_PROMPT;
    _profilePromptCache = { value, expiresAt: Date.now() + OVERRIDE_TTL_MS };
    return value;
  } catch (e) {
    console.warn(`asset_profile: prompt-override read failed, using baked default: ${e}`);
    return PROFILE_PROMPT;
  }
}

const CLIPS_BUCKET = process.env.CLIPS_BUCKET;
const CLIPS_BUCKET_OWNER = process.env.CLIPS_BUCKET_OWNER;
const ASSETS_TABLE = process.env.ASSETS_TABLE;
const KB_CACHE_TABLE = process.env.KB_CACHE_TABLE;
const PEGASUS_MODEL_ID = process.env.PEGASUS_MODEL_ID || "us.twelvelabs.pegasus-1-2-v1:0";
const KS_ROLLUP_LAMBDA = process.env.KS_ROLLUP_LAMBDA;

const PROFILE_PROMPT = `Analyze this video and respond with ONLY a single JSON object — no preamble, no code fences. Keys (all required):

{
  "title": "the canonical title or subject (short)",
  "one_liner": "one sentence describing what this video is",
  "mood_tags": ["3-6 tags from: tension, action, release, landscape, intimacy, coda, comedy, drama, horror, romance, suspense, kinetic, contemplative, ominous, triumphant, melancholy"],
  "primary_subjects": ["the 1-3 main on-screen subjects, named if recognizable"],
  "visual_style": "one of: cinematic, documentary, archival, animated, sports, news, music-video, vlog, mixed",
  "role_hint": "one of: cold-open, action-set-piece, emotional-coda, b-roll, hero-shot, transition, dialogue, atmospheric",
  "skip_ranges": [
    {"start_sec": 0.0, "end_sec": 2.5, "kind": "studio_logo | title_card | credits | fade_black | bars_tone | instructional"}
  ],
  "key_entities": [
    {
      "name": "canonical short name (Title Case for people, lowercase for objects/places)",
      "kind": "person | object | place | brand | animal",
      "appears": "brief one-line note on how/where the entity appears in this clip"
    }
  ]
}

skip_ranges should list timestamp regions a producer assembling a sizzle/highlight reel would NEVER want to pick from. Identify each as:
  - "studio_logo" (Universal/Paramount/etc card at head)
  - "title_card" (text-heavy opening title)
  - "credits" (end credits, scrolling text, copyright cards)
  - "fade_black" (a solid-black or extended-fade region > 1.5s)
  - "bars_tone" (color bars, SMPTE leader, slate)
  - "instructional" (chalkboard plays, playbook diagrams, coaching whiteboard explainers, on-screen text-tutorial overlays — any region that is teaching about the content rather than being the content; for a sports highlight reel a coach-explains-the-play sequence is "instructional" even if there's commentary audio).

If a region spans most or all of the asset duration (e.g. a 40-min coaching breakdown that's purely instructional from start to finish), mark the full duration as one "instructional" range — that's correct and lets the retrieval layer exclude the whole asset.

Use float seconds. If none are present, return an empty list.

key_entities should be 0-8 distinct entities you can identify with high confidence. Skip generic categories ("a man", "a tree") — only include entities you can name or describe specifically enough that another clip showing the same one would be recognizable.

Be terse. No prose around the JSON. Only valid JSON.`;

const JSON_RE = /\{[\s\S]*\}/;

const toDdb = (v) => {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(toDdb) };
  if (typeof v === "object") return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toDdb(x)])) };
  return { S: String(v) };
};

const fromAv = (v) => {
  if (!v) return null;
  if ("S" in v) return v.S;
  if ("N" in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  return null;
};

async function getAssetRow(assetId) {
  const out = await ddb.send(new GetItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: assetId } },
  }));
  if (!out.Item) return null;
  return {
    asset_id: fromAv(out.Item.asset_id),
    knowledge_store_id: fromAv(out.Item.knowledge_store_id),
    filename: fromAv(out.Item.filename),
  };
}

async function callPegasusForKey(s3Key) {
  const inputPrompt = await loadProfilePrompt();
  const body = {
    inputPrompt,
    mediaSource: {
      s3Location: {
        uri: `s3://${CLIPS_BUCKET}/${s3Key}`,
        bucketOwner: CLIPS_BUCKET_OWNER,
      },
    },
    temperature: 0.2,
  };
  const resp = await br.send(new InvokeModelCommand({
    modelId: PEGASUS_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  }));
  const payload = JSON.parse(new TextDecoder().decode(resp.body));
  const text = payload.message || "";
  const m = JSON_RE.exec(text);
  if (!m) {
    throw new Error(`Pegasus returned non-JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(m[0]);
}

// Pegasus sometimes rejects the raw source mp4 with
// `ValidationException: Unprocessable video, please check the video codec
// or duration`. MediaConvert produces a `<asset_id>_normalized.mp4`
// sibling that's H.264 baseline + AAC — Pegasus accepts that reliably.
// Try the raw source first (fastest path; works on >99 % of uploads), and
// fall back to the normalized version only if Pegasus refused the codec.
async function callPegasus(assetId) {
  try {
    return await callPegasusForKey(`clips/${assetId}.mp4`);
  } catch (e) {
    const msg = String(e?.message || e);
    const isCodecRefusal =
      e?.name === "ValidationException" &&
      /Unprocessable video|codec|duration/i.test(msg);
    if (!isCodecRefusal) throw e;
    console.log(`asset_profile: ${assetId} raw mp4 refused by Pegasus, retrying with _normalized.mp4`);
    return await callPegasusForKey(`clips/${assetId}_normalized.mp4`);
  }
}

async function writeAssetRow(ksId, assetId, profile) {
  const item = {
    pk: { S: `ks#${ksId}` },
    sk: { S: `ASSET#${assetId}` },
    asset_id: { S: assetId },
    ingested_at: { N: String(Math.floor(Date.now() / 1000)) },
  };
  for (const [k, v] of Object.entries(profile)) {
    if (v === null || v === undefined || v === "") continue;
    item[k] = toDdb(v);
  }
  await ddb.send(new PutItemCommand({ TableName: KB_CACHE_TABLE, Item: item }));
}

// ── Main handler ──────────────────────────────────────────────────────────
export const handler = async (event) => {
  for (const rec of event.Records || []) {
    const key = decodeURIComponent(String(rec.s3?.object?.key || "").replace(/\+/g, " "));
    const m = key.match(/^clips\/([0-9a-f]{24})\.mp4$/);
    if (!m) continue;
    const assetId = m[1];

    let row;
    try {
      row = await getAssetRow(assetId);
    } catch (e) {
      console.warn(`asset_profile: assets row read failed for ${assetId}`, e);
      continue;
    }
    if (!row || !row.knowledge_store_id) {
      console.warn(`asset_profile: no assets row or missing ks for ${assetId}; skip`);
      continue;
    }

    let profile;
    try {
      profile = await callPegasus(assetId);
    } catch (e) {
      console.warn(`asset_profile: Pegasus failed for ${assetId}: ${e}`);
      continue;
    }

    try {
      await writeAssetRow(row.knowledge_store_id, assetId, profile);
      console.log(`asset_profile: ${assetId} → ASSET# row written (ks=${row.knowledge_store_id})`);
    } catch (e) {
      console.warn(`asset_profile: write failed for ${assetId}`, e);
      continue;
    }

    // Fire ks_rollup async for this KS so OVERVIEW / ENTITY# / EVENT#
    // rows update within seconds of the last asset finishing profiling.
    // Without this, get_kb_overview stays cached=false until the next
    // scheduled 4-hour rollup and the agent falls back to slow live
    // retrieval. Best-effort: an Invoke failure here doesn't reverse the
    // ASSET# write.
    if (KS_ROLLUP_LAMBDA) {
      try {
        await lam.send(new InvokeCommand({
          FunctionName:   KS_ROLLUP_LAMBDA,
          InvocationType: "Event",
          Payload:        Buffer.from(JSON.stringify({ ks_id: row.knowledge_store_id })),
        }));
        console.log(`asset_profile: queued ks_rollup for ks=${row.knowledge_store_id}`);
      } catch (e) {
        console.warn(`asset_profile: ks_rollup invoke failed for ks=${row.knowledge_store_id}`, e);
      }
    }
  }
  return { ok: true };
};
