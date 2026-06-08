// ks_rollup — Cross-asset aggregation for every knowledge store.
//
// Triggered by EventBridge on a schedule (every 4 h by default). For each
// KS row:
//   1. Query every kb_cache ASSET# row (per-asset Pegasus profiles).
//   2. Aggregate the named key_entities across assets → ENTITY#<canonical>
//      rows (the cross-asset entity graph the Tier-1 tools read).
//   3. Compute an OVERVIEW digest (mood histogram, style histogram, role
//      histogram, sample titles, entity count) → OVERVIEW row.
//   4. Call Claude haiku once per KS to cluster multi-asset events from the
//      pooled one_liner + mood_tags → EVENT#<event_id> rows.
//
// Idempotent. Skips KSes with zero ASSET# rows (nothing to roll up yet).
// Skips KSes where the OVERVIEW.ingested_at is newer than the most recent
// ASSET# ingested_at (no change since last rollup).

import {
  DynamoDBClient,
  ScanCommand, QueryCommand,
  PutItemCommand, BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const ddb = new DynamoDBClient({});
const br = new BedrockRuntimeClient({});

const KS_TABLE = process.env.KS_TABLE;
const KB_CACHE_TABLE = process.env.KB_CACHE_TABLE;
const CLAUDE_MODEL_ID = process.env.CLAUDE_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";

// ── DDB helpers ──────────────────────────────────────────────────────────
const fromAv = (v) => {
  if (!v) return null;
  if ("S" in v) return v.S;
  if ("N" in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  if ("L" in v) return v.L.map(fromAv);
  if ("M" in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromAv(x)]));
  if ("NULL" in v) return null;
  return null;
};
const itemToObj = (item) => Object.fromEntries(Object.entries(item || {}).map(([k, v]) => [k, fromAv(v)]));
const toDdb = (v) => {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(toDdb) };
  if (typeof v === "object") return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toDdb(x)])) };
  return { S: String(v) };
};

async function listKsIds() {
  const out = [];
  let last;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: KS_TABLE, ProjectionExpression: "ks_id",
      ExclusiveStartKey: last,
    }));
    for (const it of r.Items || []) out.push(it.ks_id.S);
    last = r.LastEvaluatedKey;
  } while (last);
  return out;
}

async function listAssetProfiles(ksId) {
  const rows = [];
  let last;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: KB_CACHE_TABLE,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": { S: `ks#${ksId}` }, ":s": { S: "ASSET#" } },
      ExclusiveStartKey: last,
    }));
    for (const it of r.Items || []) rows.push(itemToObj(it));
    last = r.LastEvaluatedKey;
  } while (last);
  return rows;
}

async function readOverviewIngestedAt(ksId) {
  const r = await ddb.send(new QueryCommand({
    TableName: KB_CACHE_TABLE,
    KeyConditionExpression: "pk = :p AND sk = :s",
    ExpressionAttributeValues: { ":p": { S: `ks#${ksId}` }, ":s": { S: "OVERVIEW" } },
    ProjectionExpression: "ingested_at",
  }));
  const it = (r.Items || [])[0];
  return it ? fromAv(it.ingested_at) : null;
}

// ── Aggregation logic ───────────────────────────────────────────────────
function canonical(name) {
  return String(name || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function buildOverview(profiles) {
  const moods = {}, styles = {}, roles = {};
  const titles = [];
  let entityCount = 0;
  for (const p of profiles) {
    for (const m of (p.mood_tags || [])) {
      if (typeof m === "string") moods[m.toLowerCase()] = (moods[m.toLowerCase()] || 0) + 1;
    }
    const s = p.visual_style;
    if (typeof s === "string") styles[s.toLowerCase()] = (styles[s.toLowerCase()] || 0) + 1;
    const r = p.role_hint;
    if (typeof r === "string") roles[r.toLowerCase()] = (roles[r.toLowerCase()] || 0) + 1;
    if (typeof p.title === "string") titles.push(p.title);
    entityCount += (p.key_entities || []).length;
  }
  const topN = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    asset_count: profiles.length,
    top_moods: topN(moods, 15),
    top_styles: topN(styles, 8),
    top_roles: topN(roles, 8),
    sample_titles: titles.slice(0, 30),
    entity_count: entityCount,
  };
}

function aggregateEntities(profiles) {
  const byCanon = {};
  for (const p of profiles) {
    const aid = p.asset_id;
    if (!aid) continue;
    for (const ent of (p.key_entities || [])) {
      if (!ent || typeof ent !== "object") continue;
      const raw = ent.name;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const c = canonical(raw);
      if (!byCanon[c]) {
        byCanon[c] = { name: raw, canonical: c, kind: ent.kind || "unknown", asset_ids: [], appearance_count: 0, aliases: new Set() };
      }
      const row = byCanon[c];
      if (!row.asset_ids.includes(aid)) row.asset_ids.push(aid);
      row.appearance_count += 1;
      if (raw !== row.name) row.aliases.add(raw);
    }
  }
  return Object.values(byCanon).map((r) => ({ ...r, aliases: [...r.aliases] }));
}

async function clusterEvents(ksId, profiles) {
  if (profiles.length < 2) return [];
  const summary = profiles.map((p) => ({
    asset_id: p.asset_id,
    title: p.title,
    one_liner: p.one_liner,
    mood_tags: p.mood_tags,
    primary_subjects: p.primary_subjects,
  }));
  const prompt = `You are a story-structure analyst. Given the per-clip profiles below, identify multi-clip EVENTS — recurring scenes or motifs that span >= 2 clips and share a coherent description.

Output ONLY a JSON array, no preamble. Each element:
{
  "event_id": "evt_<short-slug>",
  "description": "one-line description of the recurring event",
  "mood_signature": ["3-5 tags from the per-clip mood_tags"],
  "participating_assets": ["asset_id_1", "asset_id_2", ...],
  "confidence": 0.0-1.0,
  "cluster_size": <integer matching participating_assets length>
}

Skip pairs that share only a generic mood (e.g. both "tense"); the event must be SPECIFIC (a chase, a confrontation, a montage of a particular activity). Maximum 12 events. Skip if no real clusters exist (return []).

Per-clip profiles:
${JSON.stringify(summary, null, 2)}`;

  try {
    const resp = await br.send(new InvokeModelCommand({
      modelId: CLAUDE_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    }));
    const payload = JSON.parse(new TextDecoder().decode(resp.body));
    const text = payload?.content?.[0]?.text || "";
    const m = /\[[\s\S]*\]/.exec(text);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn(`ks_rollup ${ksId}: event clustering failed`, e);
    return [];
  }
}

// ── Writes ──────────────────────────────────────────────────────────────
async function writeOverview(ksId, overview) {
  const item = { pk: { S: `ks#${ksId}` }, sk: { S: "OVERVIEW" }, ingested_at: { N: String(Math.floor(Date.now() / 1000)) } };
  for (const [k, v] of Object.entries(overview)) {
    if (v === null || v === undefined || v === "") continue;
    item[k] = toDdb(v);
  }
  await ddb.send(new PutItemCommand({ TableName: KB_CACHE_TABLE, Item: item }));
}

async function writeEntities(ksId, entities) {
  // BatchWriteItem in chunks of 25.
  const ts = Math.floor(Date.now() / 1000);
  for (let i = 0; i < entities.length; i += 25) {
    const batch = entities.slice(i, i + 25).map((e) => ({
      PutRequest: { Item: {
        pk: { S: `ks#${ksId}` },
        sk: { S: `ENTITY#${e.canonical}` },
        canonical: { S: e.canonical },
        name: { S: e.name },
        kind: { S: e.kind },
        asset_ids: { L: e.asset_ids.map((a) => ({ S: a })) },
        appearance_count: { N: String(e.appearance_count) },
        aliases: { L: e.aliases.map((a) => ({ S: a })) },
        ingested_at: { N: String(ts) },
      }},
    }));
    if (batch.length) {
      await ddb.send(new BatchWriteItemCommand({ RequestItems: { [KB_CACHE_TABLE]: batch } }));
    }
  }
}

async function writeEvents(ksId, events) {
  const ts = Math.floor(Date.now() / 1000);
  for (let i = 0; i < events.length; i += 25) {
    const batch = events.slice(i, i + 25).map((e) => {
      const item = {
        pk: { S: `ks#${ksId}` },
        sk: { S: `EVENT#${e.event_id || `evt_${Math.random().toString(36).slice(2, 10)}`}` },
        event_id: { S: e.event_id || "" },
        description: { S: e.description || "" },
        cluster_size: { N: String(e.cluster_size || (e.participating_assets || []).length) },
        confidence: { N: String(e.confidence || 0) },
        participating_assets: { L: (e.participating_assets || []).map((a) => ({ S: a })) },
        mood_signature: { L: (e.mood_signature || []).map((a) => ({ S: a })) },
        ingested_at: { N: String(ts) },
      };
      return { PutRequest: { Item: item } };
    });
    if (batch.length) {
      await ddb.send(new BatchWriteItemCommand({ RequestItems: { [KB_CACHE_TABLE]: batch } }));
    }
  }
}

// ── Main handler ───────────────────────────────────────────────────────
export const handler = async (event) => {
  // EventBridge schedule passes `detail-type: Scheduled Event`; manual
  // invocations can pass { ks_id: "..." } to force-roll one KS.
  const oneKs = event?.ks_id;
  const ksIds = oneKs ? [oneKs] : await listKsIds();
  console.log(`ks_rollup: rolling up ${ksIds.length} KSes`);

  const results = [];
  for (const ksId of ksIds) {
    try {
      const profiles = await listAssetProfiles(ksId);
      if (!profiles.length) {
        results.push({ ks_id: ksId, status: "skip-empty" });
        continue;
      }
      const latestProfile = Math.max(...profiles.map((p) => p.ingested_at || 0));
      const ovIng = await readOverviewIngestedAt(ksId);
      if (!oneKs && ovIng != null && ovIng >= latestProfile) {
        results.push({ ks_id: ksId, status: "skip-unchanged", profiles: profiles.length });
        continue;
      }

      const overview = buildOverview(profiles);
      const entities = aggregateEntities(profiles);
      await writeOverview(ksId, overview);
      await writeEntities(ksId, entities);

      const events = await clusterEvents(ksId, profiles);
      if (events.length) await writeEvents(ksId, events);

      results.push({
        ks_id: ksId, status: "rolled-up",
        profiles: profiles.length,
        entities: entities.length,
        events: events.length,
      });
      console.log(`ks_rollup ${ksId}: profiles=${profiles.length} entities=${entities.length} events=${events.length}`);
    } catch (e) {
      results.push({ ks_id: ksId, status: "error", error: String(e?.message || e) });
      console.warn(`ks_rollup ${ksId}: error`, e);
    }
  }
  return { ok: true, results };
};
