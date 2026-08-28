// Graph writer for Neptune Analytics.
//
// Called from ks_rollup after DDB writes succeed. Best-effort — a graph
// outage logs a warning but does not fail the rollup.
//
// Schema:
//
//   Nodes
//     (:Asset      {asset_id, ks_id, title, one_liner, visual_style, role_hint})
//     (:Entity     {canonical, ks_id, name, kind, appearance_count})
//     (:Event      {event_id, ks_id, description, cluster_size, confidence, mood_signature})
//     (:Celebrity  {name, ks_id, asset_count})
//     (:MoodTag    {name, ks_id})
//     (:Style      {name, ks_id})
//     (:Role       {name, ks_id})
//
//   Edges
//     (Asset)-[:APPEARS_IN]->(Entity)                       // Pegasus key_entities
//     (Asset)-[:HAS_CELEBRITY]->(Celebrity)                 // Rekognition faces
//     (Asset)-[:HAS_MOOD]->(MoodTag)                        // mood_tags[]
//     (Asset)-[:HAS_STYLE]->(Style)                         // visual_style
//     (Asset)-[:HAS_ROLE]->(Role)                           // role_hint
//     (Event)-[:CONTAINS]->(Asset)                          // multi-clip cluster
//     (Entity)-[:CO_OCCURS_WITH {weight}]->(Entity)         // shared-asset count
//
// Every node carries `ks_id` so a subgraph query can scope to one KB
// without cross-KS spillover. Merge keys: Asset by (ks_id, asset_id),
// Entity by (ks_id, canonical), etc.

import { NeptuneGraphClient, ExecuteQueryCommand } from "@aws-sdk/client-neptune-graph";

const GRAPH_ID = process.env.GRAPH_ID;
const client = GRAPH_ID ? new NeptuneGraphClient({}) : null;

async function runQuery(queryString, parameters) {
  if (!client || !GRAPH_ID) return null;
  const out = await client.send(new ExecuteQueryCommand({
    graphIdentifier: GRAPH_ID,
    language: "OPEN_CYPHER",
    queryString,
    parameters,
    planCache: "AUTO",
  }));
  // The payload is a stream; drain but ignore — MERGE queries don't
  // return rows worth reading here.
  if (out.payload) await out.payload.transformToString();
  return out;
}

// Neptune Analytics kills an UNWIND with too many rows in one query —
// `UnprocessableException: Operation terminated (out of memory)` at
// 32 m-NCU even for batches of 500 on this graph's size. 100 rows per
// call stays under the ceiling in practice; bump if you scale up the
// graph capacity and see per-call latency dominate.
const BATCH_SIZE = 100;

// Fan out an UNWIND-driven MERGE across chunks so a corpus of tens of
// thousands of rows doesn't OOM the graph on a single call.
async function runQueryBatched(queryString, ksId, rows, extraParams = {}) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    await runQuery(queryString, { ks_id: ksId, rows: chunk, ...extraParams });
  }
}

// One UNWIND-driven MERGE per node/edge shape. Batching in a single
// statement is much cheaper than one round-trip per row.

async function upsertAssets(ksId, profiles) {
  const rows = profiles.map((p) => ({
    asset_id:     p.asset_id,
    title:        p.title || "",
    one_liner:    p.one_liner || "",
    visual_style: p.visual_style || "",
    role_hint:    p.role_hint || "",
  }));
  await runQueryBatched(`
    UNWIND $rows AS row
    MERGE (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
    SET a.title        = row.title,
        a.one_liner    = row.one_liner,
        a.visual_style = row.visual_style,
        a.role_hint    = row.role_hint
  `, ksId, rows);
}

async function upsertMoodStyleRoleEdges(ksId, profiles) {
  const moodRows  = [];
  const styleRows = [];
  const roleRows  = [];
  for (const p of profiles) {
    for (const m of (p.mood_tags || [])) {
      if (typeof m === "string" && m.trim()) moodRows.push({ asset_id: p.asset_id, name: m.trim().toLowerCase() });
    }
    if (typeof p.visual_style === "string" && p.visual_style.trim()) {
      styleRows.push({ asset_id: p.asset_id, name: p.visual_style.trim().toLowerCase() });
    }
    if (typeof p.role_hint === "string" && p.role_hint.trim()) {
      roleRows.push({ asset_id: p.asset_id, name: p.role_hint.trim().toLowerCase() });
    }
  }
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
    MERGE (m:MoodTag {ks_id: $ks_id, name: row.name})
    MERGE (a)-[:HAS_MOOD]->(m)
  `, ksId, moodRows);
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
    MERGE (s:Style {ks_id: $ks_id, name: row.name})
    MERGE (a)-[:HAS_STYLE]->(s)
  `, ksId, styleRows);
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
    MERGE (r:Role {ks_id: $ks_id, name: row.name})
    MERGE (a)-[:HAS_ROLE]->(r)
  `, ksId, roleRows);
}

async function upsertEntities(ksId, entities) {
  if (!entities.length) return;
  const nodeRows = entities.map((e) => ({
    canonical:        e.canonical,
    name:             e.name,
    kind:             e.kind || "unknown",
    appearance_count: e.appearance_count,
  }));
  await runQueryBatched(`
    UNWIND $rows AS row
    MERGE (e:Entity {ks_id: $ks_id, canonical: row.canonical})
    SET e.name             = row.name,
        e.kind             = row.kind,
        e.appearance_count = row.appearance_count
  `, ksId, nodeRows);

  // APPEARS_IN edges: one per (asset, entity) pair.
  const edgeRows = [];
  for (const e of entities) {
    for (const aid of e.asset_ids || []) {
      edgeRows.push({ asset_id: aid, canonical: e.canonical });
    }
  }
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (a:Asset  {ks_id: $ks_id, asset_id: row.asset_id})
    MATCH (e:Entity {ks_id: $ks_id, canonical: row.canonical})
    MERGE (a)-[:APPEARS_IN]->(e)
  `, ksId, edgeRows);
}

async function upsertEntityCoOccurrence(ksId, entities) {
  // weight = # of assets in which BOTH entities appear. O(N²) in the
  // entity count; capped at the top 200 by appearance_count to keep the
  // graph readable and the write bounded.
  const top = [...entities].sort((a, b) => b.appearance_count - a.appearance_count).slice(0, 200);
  const rows = [];
  for (let i = 0; i < top.length; i++) {
    const a = top[i];
    const aSet = new Set(a.asset_ids || []);
    if (!aSet.size) continue;
    for (let j = i + 1; j < top.length; j++) {
      const b = top[j];
      let shared = 0;
      for (const aid of (b.asset_ids || [])) if (aSet.has(aid)) shared++;
      if (shared >= 2) rows.push({ a: a.canonical, b: b.canonical, weight: shared });
    }
  }
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (a:Entity {ks_id: $ks_id, canonical: row.a})
    MATCH (b:Entity {ks_id: $ks_id, canonical: row.b})
    MERGE (a)-[r:CO_OCCURS_WITH]->(b)
    SET r.weight = row.weight
  `, ksId, rows);
}

async function upsertEvents(ksId, events) {
  if (!events.length) return;
  // Event records carry the constituent asset list as `participating_assets`
  // (matches the DDB shape written by ks_rollup and the JSON contract with
  // the Claude clustering step). We tolerate the legacy `asset_ids` name for
  // any records lingering from earlier iterations.
  const assetsOn = (e) => e.participating_assets || e.asset_ids || [];
  const nodeRows = events.map((e) => ({
    event_id:       e.event_id,
    description:    e.description || "",
    cluster_size:   e.cluster_size || assetsOn(e).length,
    confidence:     e.confidence || 0,
    mood_signature: (e.mood_signature || []).join(","),
  }));
  await runQueryBatched(`
    UNWIND $rows AS row
    MERGE (ev:Event {ks_id: $ks_id, event_id: row.event_id})
    SET ev.description    = row.description,
        ev.cluster_size   = row.cluster_size,
        ev.confidence     = row.confidence,
        ev.mood_signature = row.mood_signature
  `, ksId, nodeRows);

  const edgeRows = [];
  for (const e of events) {
    for (const aid of assetsOn(e)) {
      edgeRows.push({ event_id: e.event_id, asset_id: aid });
    }
  }
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (ev:Event {ks_id: $ks_id, event_id: row.event_id})
    MATCH (a:Asset  {ks_id: $ks_id, asset_id: row.asset_id})
    MERGE (ev)-[:CONTAINS]->(a)
  `, ksId, edgeRows);
}

async function upsertCelebrities(ksId, celebrities) {
  if (!celebrities.length) return;
  const nodeRows = celebrities.map((c) => ({
    name:        c.name,
    asset_count: (c.asset_ids || []).length,
  }));
  await runQueryBatched(`
    UNWIND $rows AS row
    MERGE (c:Celebrity {ks_id: $ks_id, name: row.name})
    SET c.asset_count = row.asset_count
  `, ksId, nodeRows);

  const edgeRows = [];
  for (const c of celebrities) {
    for (const aid of c.asset_ids || []) {
      edgeRows.push({ name: c.name, asset_id: aid });
    }
  }
  await runQueryBatched(`
    UNWIND $rows AS row
    MATCH (c:Celebrity {ks_id: $ks_id, name: row.name})
    MATCH (a:Asset     {ks_id: $ks_id, asset_id: row.asset_id})
    MERGE (a)-[:HAS_CELEBRITY]->(c)
  `, ksId, edgeRows);
}

/**
 * Sync the full per-KS graph in dependency order. Nodes first, then
 * edges. Idempotent — every write is a MERGE keyed on (ks_id + natural
 * key), so a repeat call converges on the same graph.
 *
 * @param {string} ksId
 * @param {Array}  profiles     kb_cache ASSET# rows for this KS
 * @param {Array}  entities     aggregated entity records
 * @param {Array}  events       clustered event records
 * @param {Array}  celebrities  aggregated celebrity records
 */
export async function syncGraphForKs(ksId, profiles, entities, events, celebrities) {
  if (!GRAPH_ID) {
    console.log(`ks_rollup ${ksId}: GRAPH_ID unset, skipping graph sync`);
    return { skipped: true };
  }
  try {
    await upsertAssets(ksId, profiles);
    await upsertMoodStyleRoleEdges(ksId, profiles);
    await upsertEntities(ksId, entities);
    await upsertEntityCoOccurrence(ksId, entities);
    await upsertEvents(ksId, events);
    await upsertCelebrities(ksId, celebrities);
    return { ok: true };
  } catch (e) {
    console.warn(`ks_rollup ${ksId}: graph sync failed`, e);
    return { ok: false, error: String(e?.message || e) };
  }
}
