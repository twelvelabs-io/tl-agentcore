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

async function runQuery(query, parameters) {
  if (!client || !GRAPH_ID) return null;
  const out = await client.send(new ExecuteQueryCommand({
    graphIdentifier: GRAPH_ID,
    language: "OPEN_CYPHER",
    query,
    parameters,
    planCache: "AUTO",
  }));
  // The payload is a stream; drain but ignore — MERGE queries don't
  // return rows worth reading here.
  if (out.payload) await out.payload.transformToString();
  return out;
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
  await runQuery(`
    UNWIND $rows AS row
    MERGE (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
    SET a.title        = row.title,
        a.one_liner    = row.one_liner,
        a.visual_style = row.visual_style,
        a.role_hint    = row.role_hint
  `, { ks_id: ksId, rows });
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
  if (moodRows.length) {
    await runQuery(`
      UNWIND $rows AS row
      MATCH (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
      MERGE (m:MoodTag {ks_id: $ks_id, name: row.name})
      MERGE (a)-[:HAS_MOOD]->(m)
    `, { ks_id: ksId, rows: moodRows });
  }
  if (styleRows.length) {
    await runQuery(`
      UNWIND $rows AS row
      MATCH (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
      MERGE (s:Style {ks_id: $ks_id, name: row.name})
      MERGE (a)-[:HAS_STYLE]->(s)
    `, { ks_id: ksId, rows: styleRows });
  }
  if (roleRows.length) {
    await runQuery(`
      UNWIND $rows AS row
      MATCH (a:Asset {ks_id: $ks_id, asset_id: row.asset_id})
      MERGE (r:Role {ks_id: $ks_id, name: row.name})
      MERGE (a)-[:HAS_ROLE]->(r)
    `, { ks_id: ksId, rows: roleRows });
  }
}

async function upsertEntities(ksId, entities) {
  if (!entities.length) return;
  const nodeRows = entities.map((e) => ({
    canonical:        e.canonical,
    name:             e.name,
    kind:             e.kind || "unknown",
    appearance_count: e.appearance_count,
  }));
  await runQuery(`
    UNWIND $rows AS row
    MERGE (e:Entity {ks_id: $ks_id, canonical: row.canonical})
    SET e.name             = row.name,
        e.kind             = row.kind,
        e.appearance_count = row.appearance_count
  `, { ks_id: ksId, rows: nodeRows });

  // APPEARS_IN edges: one per (asset, entity) pair.
  const edgeRows = [];
  for (const e of entities) {
    for (const aid of e.asset_ids || []) {
      edgeRows.push({ asset_id: aid, canonical: e.canonical });
    }
  }
  if (edgeRows.length) {
    await runQuery(`
      UNWIND $rows AS row
      MATCH (a:Asset  {ks_id: $ks_id, asset_id: row.asset_id})
      MATCH (e:Entity {ks_id: $ks_id, canonical: row.canonical})
      MERGE (a)-[:APPEARS_IN]->(e)
    `, { ks_id: ksId, rows: edgeRows });
  }
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
  if (!rows.length) return;
  await runQuery(`
    UNWIND $rows AS row
    MATCH (a:Entity {ks_id: $ks_id, canonical: row.a})
    MATCH (b:Entity {ks_id: $ks_id, canonical: row.b})
    MERGE (a)-[r:CO_OCCURS_WITH]->(b)
    SET r.weight = row.weight
  `, { ks_id: ksId, rows });
}

async function upsertEvents(ksId, events) {
  if (!events.length) return;
  const nodeRows = events.map((e) => ({
    event_id:       e.event_id,
    description:    e.description || "",
    cluster_size:   e.cluster_size || (e.asset_ids || []).length,
    confidence:     e.confidence || 0,
    mood_signature: (e.mood_signature || []).join(","),
  }));
  await runQuery(`
    UNWIND $rows AS row
    MERGE (ev:Event {ks_id: $ks_id, event_id: row.event_id})
    SET ev.description    = row.description,
        ev.cluster_size   = row.cluster_size,
        ev.confidence     = row.confidence,
        ev.mood_signature = row.mood_signature
  `, { ks_id: ksId, rows: nodeRows });

  const edgeRows = [];
  for (const e of events) {
    for (const aid of e.asset_ids || []) {
      edgeRows.push({ event_id: e.event_id, asset_id: aid });
    }
  }
  if (edgeRows.length) {
    await runQuery(`
      UNWIND $rows AS row
      MATCH (ev:Event {ks_id: $ks_id, event_id: row.event_id})
      MATCH (a:Asset  {ks_id: $ks_id, asset_id: row.asset_id})
      MERGE (ev)-[:CONTAINS]->(a)
    `, { ks_id: ksId, rows: edgeRows });
  }
}

async function upsertCelebrities(ksId, celebrities) {
  if (!celebrities.length) return;
  const nodeRows = celebrities.map((c) => ({
    name:        c.name,
    asset_count: (c.asset_ids || []).length,
  }));
  await runQuery(`
    UNWIND $rows AS row
    MERGE (c:Celebrity {ks_id: $ks_id, name: row.name})
    SET c.asset_count = row.asset_count
  `, { ks_id: ksId, rows: nodeRows });

  const edgeRows = [];
  for (const c of celebrities) {
    for (const aid of c.asset_ids || []) {
      edgeRows.push({ name: c.name, asset_id: aid });
    }
  }
  if (edgeRows.length) {
    await runQuery(`
      UNWIND $rows AS row
      MATCH (c:Celebrity {ks_id: $ks_id, name: row.name})
      MATCH (a:Asset     {ks_id: $ks_id, asset_id: row.asset_id})
      MERGE (a)-[:HAS_CELEBRITY]->(c)
    `, { ks_id: ksId, rows: edgeRows });
  }
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
