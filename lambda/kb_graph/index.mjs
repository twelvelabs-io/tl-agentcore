// kb_graph — Neptune Analytics-backed subgraph for one knowledge_store.
//
// Serves the same `{nodes, edges, overview, counts}` shape the UI's
// React Flow component expects, but reads from the property graph
// (populated by ks_rollup + enrich_comprehend) instead of scanning the
// kb_cache DDB rows.
//
// Node kinds:
//   asset        one per Asset node
//   entity       one per Entity node (Pegasus- OR Comprehend-derived)
//   event        one per Event node
//   celebrity    one per Celebrity node
//
// Edge kinds surfaced to the UI (mapped from graph edge labels):
//   APPEARS_IN         → "appears_in"        (Asset → Entity, visual)
//   MENTIONED_IN       → "mentioned_in"      (Entity → Asset, dialogue)
//   HAS_CELEBRITY      → "appears_in"        (Asset → Celebrity)
//   CONTAINS           → "participates_in"   (Event  → Asset)
//   CO_OCCURS_WITH     → "co_occurs"         (Entity ↔ Entity, weighted)
//
// GET /kb-graph?ks_id=ks_xxxx
//   200 { nodes: [...], edges: [...], overview, counts }
//   400 { error: "ks_id required" }
//   401 { error: "missing Authorization: Bearer ..." }
//   404 { error: "ks not found" }
//   500 { error: "..." }

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { NeptuneGraphClient, ExecuteQueryCommand } from "@aws-sdk/client-neptune-graph";
import { authorize } from "./auth.mjs";

const ddb = new DynamoDBClient({});
const GRAPH_ID = process.env.GRAPH_ID;
const graph = GRAPH_ID ? new NeptuneGraphClient({}) : null;

const KB_CACHE_TABLE = process.env.KB_CACHE_TABLE;
const KS_TABLE       = process.env.KS_TABLE;
const ADMIN_GROUP    = process.env.ADMIN_GROUP_NAME || "admins";

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Ownership check for KS reads. Returns null if allowed, or a reply.
async function checkKsRead(ks_id, identity) {
  if (!KS_TABLE) return null;
  const isAdmin = Array.isArray(identity.groups) && identity.groups.includes(ADMIN_GROUP);
  if (isAdmin) return null;
  const out = await ddb.send(new GetItemCommand({
    TableName: KS_TABLE, Key: { ks_id: { S: ks_id } },
  }));
  if (!out.Item) return reply(404, { error: "ks not found" });
  const owner = out.Item.owner_sub?.S;
  if (!owner) return null; // legacy row, shared read
  if (owner !== identity.sub) return reply(403, { error: "not allowed to read this ks" });
  return null;
}

async function runQuery(queryString, parameters) {
  const out = await graph.send(new ExecuteQueryCommand({
    graphIdentifier: GRAPH_ID,
    language: "OPEN_CYPHER",
    queryString,
    parameters,
    planCache: "AUTO",
  }));
  const raw = out.payload ? await out.payload.transformToString() : "";
  return raw ? JSON.parse(raw) : {};
}

// One query per node kind — cheaper on the response side than a UNION
// with heterogeneous keys, and easier to translate to the UI's typed
// data shapes.
async function fetchAssets(ksId) {
  const r = await runQuery(`
    MATCH (a:Asset {ks_id: $ks_id})
    OPTIONAL MATCH (a)-[:HAS_MOOD]->(m:MoodTag)
    WITH a, collect(DISTINCT m.name) AS mood_tags
    RETURN a.asset_id AS asset_id, a.title AS title, a.one_liner AS one_liner,
           a.role_hint AS role_hint, a.visual_style AS visual_style,
           mood_tags
  `, { ks_id: ksId });
  return (r.results || []).map((row) => ({
    asset_id:     row.asset_id,
    title:        row.title || "untitled",
    one_liner:    row.one_liner || "",
    role_hint:    row.role_hint || null,
    visual_style: row.visual_style || null,
    mood_tags:    row.mood_tags || [],
  }));
}

async function fetchEntities(ksId) {
  const r = await runQuery(`
    MATCH (e:Entity {ks_id: $ks_id})
    OPTIONAL MATCH (a:Asset {ks_id: $ks_id})-[:APPEARS_IN]->(e)
    WITH e, collect(DISTINCT a.asset_id) AS asset_ids
    RETURN e.canonical AS canonical, e.name AS name, e.kind AS kind,
           e.appearance_count AS appearance_count, asset_ids
  `, { ks_id: ksId });
  return (r.results || []).map((row) => ({
    canonical:        row.canonical,
    name:             row.name || row.canonical,
    kind:             row.kind || "unknown",
    appearance_count: row.appearance_count || 0,
    asset_ids:        row.asset_ids || [],
  }));
}

async function fetchEvents(ksId) {
  const r = await runQuery(`
    MATCH (ev:Event {ks_id: $ks_id})
    OPTIONAL MATCH (ev)-[:CONTAINS]->(a:Asset {ks_id: $ks_id})
    WITH ev, collect(DISTINCT a.asset_id) AS participating_assets
    RETURN ev.event_id AS event_id, ev.description AS description,
           ev.cluster_size AS cluster_size, ev.confidence AS confidence,
           ev.mood_signature AS mood_signature, participating_assets
  `, { ks_id: ksId });
  return (r.results || []).map((row) => ({
    event_id:             row.event_id,
    description:          row.description || "",
    cluster_size:         row.cluster_size || 0,
    confidence:           row.confidence || 0,
    mood_signature:       (row.mood_signature || "").split(",").filter(Boolean),
    participating_assets: row.participating_assets || [],
  }));
}

async function fetchCelebrities(ksId) {
  const r = await runQuery(`
    MATCH (c:Celebrity {ks_id: $ks_id})
    OPTIONAL MATCH (a:Asset {ks_id: $ks_id})-[:HAS_CELEBRITY]->(c)
    WITH c, collect(DISTINCT a.asset_id) AS asset_ids
    RETURN c.name AS name, c.asset_count AS asset_count, asset_ids
  `, { ks_id: ksId });
  return (r.results || []).map((row) => ({
    name:             row.name,
    appearance_count: row.asset_count || (row.asset_ids || []).length,
    max_confidence:   0,
    asset_ids:        row.asset_ids || [],
  }));
}

async function fetchCoOccurrences(ksId) {
  const r = await runQuery(`
    MATCH (a:Entity {ks_id: $ks_id})-[co:CO_OCCURS_WITH]->(b:Entity {ks_id: $ks_id})
    RETURN a.canonical AS a, b.canonical AS b, co.weight AS weight
  `, { ks_id: ksId });
  return r.results || [];
}

async function fetchMentioned(ksId) {
  const r = await runQuery(`
    MATCH (e:Entity {ks_id: $ks_id})-[:MENTIONED_IN]->(a:Asset {ks_id: $ks_id})
    RETURN e.canonical AS entity, a.asset_id AS asset_id
  `, { ks_id: ksId });
  return r.results || [];
}

async function fetchOverviewRow(ksId) {
  if (!KB_CACHE_TABLE) return null;
  const out = await ddb.send(new GetItemCommand({
    TableName: KB_CACHE_TABLE,
    Key: { pk: { S: `ks#${ksId}` }, sk: { S: "OVERVIEW" } },
  }));
  if (!out.Item) return null;
  const item = out.Item;
  const fromDdb = (v) => {
    if (v == null) return null;
    if ("S" in v) return v.S;
    if ("N" in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
    if ("BOOL" in v) return v.BOOL;
    if ("L" in v) return v.L.map(fromDdb);
    if ("M" in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromDdb(x)]));
    return null;
  };
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, fromDdb(v)]));
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {}, body: "" };
  }

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });

  const qs = event.queryStringParameters || {};
  const ks_id = qs.ks_id;
  if (!ks_id) return reply(400, { error: "ks_id query param required" });

  const denial = await checkKsRead(ks_id, auth.identity);
  if (denial) return denial;

  if (!graph || !GRAPH_ID) {
    return reply(500, { error: "graph not configured (GRAPH_ID unset)" });
  }

  let assets, entities, events, celebrities, coOccurrences, mentioned, overview;
  try {
    [assets, entities, events, celebrities, coOccurrences, mentioned, overview] = await Promise.all([
      fetchAssets(ks_id),
      fetchEntities(ks_id),
      fetchEvents(ks_id),
      fetchCelebrities(ks_id),
      fetchCoOccurrences(ks_id),
      fetchMentioned(ks_id),
      fetchOverviewRow(ks_id),
    ]);
  } catch (e) {
    return reply(500, { error: "graph query failed", detail: String(e?.message || e) });
  }

  const nodes = [];
  for (const a of assets) {
    nodes.push({
      id:   `asset#${a.asset_id}`,
      kind: "asset",
      data: {
        asset_id:     a.asset_id,
        title:        a.title,
        one_liner:    a.one_liner,
        mood_tags:    a.mood_tags,
        role_hint:    a.role_hint,
        visual_style: a.visual_style,
      },
    });
  }
  for (const e of entities) {
    nodes.push({
      id:   `entity#${e.canonical}`,
      kind: "entity",
      data: {
        name:             e.name,
        canonical:        e.canonical,
        kind_label:       e.kind,
        appearance_count: e.appearance_count,
        asset_ids:        e.asset_ids,
        aliases:          [],
      },
    });
  }
  for (const ev of events) {
    nodes.push({
      id:   `event#${ev.event_id}`,
      kind: "event",
      data: {
        event_id:             ev.event_id,
        description:          ev.description,
        cluster_size:         ev.cluster_size,
        confidence:           ev.confidence,
        participating_assets: ev.participating_assets,
        mood_signature:       ev.mood_signature,
      },
    });
  }
  for (const c of celebrities) {
    nodes.push({
      id:   `celebrity#${c.name}`,
      kind: "celebrity",
      data: {
        name:             c.name,
        appearance_count: c.appearance_count,
        max_confidence:   c.max_confidence,
        asset_ids:        c.asset_ids,
      },
    });
  }

  const assetIdSet = new Set(assets.map((a) => a.asset_id));
  const entityCanonSet = new Set(entities.map((e) => e.canonical));
  const edges = [];

  // APPEARS_IN edges from Entity nodes' asset_ids
  for (const e of entities) {
    for (const aid of e.asset_ids) {
      if (!assetIdSet.has(aid)) continue;
      edges.push({
        id:     `e-ent#${e.canonical}-as#${aid}`,
        source: `entity#${e.canonical}`,
        target: `asset#${aid}`,
        kind:   "appears_in",
      });
    }
  }
  // CONTAINS (Event → Asset), rendered as "participates_in" for the UI.
  for (const ev of events) {
    for (const aid of ev.participating_assets) {
      if (!assetIdSet.has(aid)) continue;
      edges.push({
        id:     `e-ev#${ev.event_id}-as#${aid}`,
        source: `asset#${aid}`,
        target: `event#${ev.event_id}`,
        kind:   "participates_in",
      });
    }
  }
  // HAS_CELEBRITY (Asset → Celebrity), rendered as appears_in for parity
  // with entity edges.
  for (const c of celebrities) {
    for (const aid of c.asset_ids) {
      if (!assetIdSet.has(aid)) continue;
      edges.push({
        id:     `e-celeb#${c.name}-as#${aid}`,
        source: `celebrity#${c.name}`,
        target: `asset#${aid}`,
        kind:   "appears_in",
      });
    }
  }
  // MENTIONED_IN edges (Entity → Asset), separate visual/dialogue signal.
  for (const m of mentioned) {
    if (!assetIdSet.has(m.asset_id) || !entityCanonSet.has(m.entity)) continue;
    edges.push({
      id:     `e-ment#${m.entity}-as#${m.asset_id}`,
      source: `entity#${m.entity}`,
      target: `asset#${m.asset_id}`,
      kind:   "mentioned_in",
    });
  }
  // CO_OCCURS_WITH edges (Entity ↔ Entity, weighted).
  for (const co of coOccurrences) {
    if (!entityCanonSet.has(co.a) || !entityCanonSet.has(co.b)) continue;
    edges.push({
      id:     `e-co#${co.a}-${co.b}`,
      source: `entity#${co.a}`,
      target: `entity#${co.b}`,
      kind:   "co_occurs",
      weight: co.weight,
    });
  }

  return reply(200, {
    ks_id,
    nodes,
    edges,
    overview: overview ? {
      asset_count:     overview.asset_count || 0,
      entity_count:    overview.entity_count || 0,
      celebrity_count: overview.celebrity_count || 0,
      top_moods:       overview.top_moods || [],
      top_styles:      overview.top_styles || [],
      top_roles:       overview.top_roles || [],
      top_celebrities: overview.top_celebrities || [],
      sample_titles:   overview.sample_titles || [],
    } : null,
    counts: {
      assets:      assets.length,
      entities:    entities.length,
      events:      events.length,
      celebrities: celebrities.length,
      edges:       edges.length,
    },
  });
};
