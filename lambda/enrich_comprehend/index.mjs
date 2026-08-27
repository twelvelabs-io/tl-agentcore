// enrich_comprehend — S3-triggered on the Transcribe output landing
// under `transcripts/<asset_id>/<asset_id>.json`. Reads the transcript,
// runs Comprehend DetectEntities, dedupes to a canonical entity list,
// and merges `Entity —MENTIONED_IN→ Asset` edges into the graph.
//
// MENTIONED_IN is intentionally separate from APPEARS_IN. A sports
// commentator names players who aren't on screen; a news anchor names
// places that aren't shown; a documentary transcript references books
// and events with no visual. Keeping the edge kinds distinct lets the
// query layer favour visual matches when it needs to and fall back on
// mentions when it doesn't.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { ComprehendClient, DetectEntitiesCommand } from "@aws-sdk/client-comprehend";
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { NeptuneGraphClient, ExecuteQueryCommand } from "@aws-sdk/client-neptune-graph";

const s3 = new S3Client({});
const co = new ComprehendClient({});
const ddb = new DynamoDBClient({});
const GRAPH_ID = process.env.GRAPH_ID;
const graph = GRAPH_ID ? new NeptuneGraphClient({}) : null;
const ASSETS_TABLE = process.env.ASSETS_TABLE;

// Comprehend has a 5000-byte per-call limit for sync DetectEntities.
// We shard the transcript into windows of that size and merge the
// results. For very long assets (>~1h) this is 20–40 sequential calls.
// Consider ComprehendJobs (async batch) if that latency becomes an
// issue.
const COMPREHEND_MAX_BYTES = 4500;

// Only these Comprehend types map cleanly to graph entity kinds worth
// keeping. QUANTITY / DATE / OTHER are noisy in transcripts.
const KEEP_TYPES = new Set(["PERSON", "LOCATION", "ORGANIZATION", "TITLE", "EVENT", "COMMERCIAL_ITEM"]);
const KIND_MAP = {
  PERSON: "person",
  LOCATION: "place",
  ORGANIZATION: "brand",
  TITLE: "object",
  EVENT: "event",
  COMMERCIAL_ITEM: "brand",
};

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function canonical(name) {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function windowText(text, maxBytes) {
  const chunks = [];
  let buf = "";
  let bufBytes = 0;
  for (const word of text.split(/\s+/)) {
    const wb = Buffer.byteLength(word) + 1;
    if (bufBytes + wb > maxBytes && buf) {
      chunks.push(buf);
      buf = word;
      bufBytes = wb;
    } else {
      buf = buf ? `${buf} ${word}` : word;
      bufBytes += wb;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function detectAll(text, languageCode) {
  const byCanon = new Map();
  for (const window of windowText(text, COMPREHEND_MAX_BYTES)) {
    const resp = await co.send(new DetectEntitiesCommand({
      Text: window,
      LanguageCode: languageCode || "en",
    }));
    for (const e of (resp.Entities || [])) {
      if (!KEEP_TYPES.has(e.Type) || (e.Score || 0) < 0.85) continue;
      const c = canonical(e.Text || "");
      if (!c) continue;
      const existing = byCanon.get(c);
      if (existing) {
        existing.count++;
        existing.max_score = Math.max(existing.max_score, e.Score || 0);
      } else {
        byCanon.set(c, {
          canonical: c,
          name: (e.Text || "").trim(),
          kind: KIND_MAP[e.Type] || "unknown",
          max_score: e.Score || 0,
          count: 1,
        });
      }
    }
  }
  return [...byCanon.values()];
}

async function mergeIntoGraph(ksId, assetId, entities) {
  if (!graph || !GRAPH_ID || !entities.length) return;
  const rows = entities.map((e) => ({
    canonical: e.canonical,
    name:      e.name,
    kind:      e.kind,
    mentions:  e.count,
  }));
  const q = `
    UNWIND $rows AS row
    MERGE (e:Entity {ks_id: $ks_id, canonical: row.canonical})
      ON CREATE SET e.name = row.name, e.kind = row.kind, e.appearance_count = 0
    WITH row, e
    MATCH (a:Asset {ks_id: $ks_id, asset_id: $asset_id})
    MERGE (e)-[m:MENTIONED_IN]->(a)
    SET m.mention_count = row.mentions
  `;
  const out = await graph.send(new ExecuteQueryCommand({
    graphIdentifier: GRAPH_ID,
    language: "OPEN_CYPHER",
    queryString: q,
    parameters: { ks_id: ksId, asset_id: assetId, rows },
    planCache: "AUTO",
  }));
  if (out.payload) await out.payload.transformToString();
}

async function persistMentionedList(assetId, entities) {
  if (!ASSETS_TABLE || !entities.length) return;
  const namesTop = entities
    .sort((a, b) => b.count - a.count)
    .slice(0, 50)
    .map((e) => ({ M: { name: { S: e.name }, kind: { S: e.kind }, mentions: { N: String(e.count) } } }));
  await ddb.send(new UpdateItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: assetId } },
    UpdateExpression: "SET mentioned_entities = :m",
    ExpressionAttributeValues: { ":m": { L: namesTop } },
  }));
}

async function readKsId(assetId) {
  const out = await ddb.send(new GetItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: assetId } },
    ProjectionExpression: "knowledge_store_id",
  }));
  return out.Item?.knowledge_store_id?.S || null;
}

export const handler = async (event) => {
  for (const rec of event.Records || []) {
    const bucket = rec.s3?.bucket?.name;
    const key    = decodeURIComponent(String(rec.s3?.object?.key || "").replace(/\+/g, " "));
    // Trigger key pattern: transcripts/<asset_id>/<asset_id>.json
    const m = key.match(/^transcripts\/([0-9a-f]{24})\/[0-9a-f]{24}\.json$/);
    if (!m) { console.log(`enrich_comprehend: skip ${key}`); continue; }
    const assetId = m[1];

    let ksId;
    try { ksId = await readKsId(assetId); }
    catch (e) { console.warn(`enrich_comprehend: read ks for ${assetId} failed`, e); continue; }
    if (!ksId) { console.warn(`enrich_comprehend: no ks_id for ${assetId}; skip`); continue; }

    let body;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      body = JSON.parse(await streamToString(obj.Body));
    } catch (e) {
      console.warn(`enrich_comprehend: read ${key} failed`, e);
      continue;
    }
    // Transcribe JSON shape: results.transcripts[].transcript (single
    // concatenated string) + language_code.
    const text = (body?.results?.transcripts || []).map((t) => t.transcript || "").join(" ").trim();
    const lang = (body?.results?.language_code || "en").split("-")[0];
    if (!text) { console.log(`enrich_comprehend: empty transcript for ${assetId}`); continue; }

    let entities;
    try { entities = await detectAll(text, lang); }
    catch (e) { console.warn(`enrich_comprehend: Comprehend failed for ${assetId}`, e); continue; }
    console.log(`enrich_comprehend: ${assetId} → ${entities.length} entities from ${text.length} chars`);

    try { await persistMentionedList(assetId, entities); }
    catch (e) { console.warn(`enrich_comprehend: DDB write failed for ${assetId}`, e); }

    try { await mergeIntoGraph(ksId, assetId, entities); }
    catch (e) { console.warn(`enrich_comprehend: graph merge failed for ${assetId}`, e); }
  }
  return { ok: true };
};
