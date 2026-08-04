// kb_graph — Dump the Phase 1/2/4 knowledge graph for one knowledge_store as
// a {nodes, edges} payload the UI's React Flow component can render.
//
// Reads from the same kb_cache DDB table the agent's Tier-1 tools use:
//   pk = "ks#<ks_id>"  sk = "OVERVIEW"        — corpus digest
//   pk = "ks#<ks_id>"  sk = "ASSET#<asset_id>" — Pegasus profile
//   pk = "ks#<ks_id>"  sk = "ENTITY#<canon>"  — cross-asset entity record
//   pk = "ks#<ks_id>"  sk = "EVENT#<event_id>" — multi-clip cluster
//
// Nodes by kind:
//   asset   ← one per ASSET# row
//   entity  ← one per ENTITY# row
//   event   ← one per EVENT# row
// Edges:
//   entity → asset  (one per asset_id in entity.asset_ids)
//   asset  → event  (one per asset_id in event.participating_assets)
//
// Layout coords are NOT computed here — React Flow's layout runs client-side
// (force-directed) so the BFF stays cheap and side-effect-free.
//
// GET /kb-graph?ks_id=ks_xxxx
//   200 { nodes: [...], edges: [...], counts: {assets, entities, events} }
//   400 { error: "ks_id required" }
//   401 { error: "missing Authorization: Bearer ..." }
//   500 { error: "..." }

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { authorize } from "./auth.mjs";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

const KB_CACHE_TABLE = process.env.KB_CACHE_TABLE;
const KS_TABLE       = process.env.KS_TABLE;
const ADMIN_GROUP    = process.env.ADMIN_GROUP_NAME || "admins";

// Ownership check for KS reads. Returns null if the caller is
// allowed, or a { statusCode, body } reply if not. Legacy KSes
// without owner_sub are considered shared (backwards compat with
// pre-migration rows).
async function checkKsRead(ks_id, identity) {
  if (!KS_TABLE) return null; // env not wired, fail-open pre-migration
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

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// DDB AttributeValue → plain JS. Matches scripts/build_event_groups.py's _from_ddb.
const fromDdb = (v) => {
  if (v == null) return null;
  if ("S" in v) return v.S;
  if ("N" in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  if ("L" in v) return v.L.map(fromDdb);
  if ("M" in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromDdb(x)]));
  if ("NULL" in v) return null;
  if ("SS" in v) return [...v.SS];
  if ("NS" in v) return v.NS.map((n) => (n.includes(".") ? parseFloat(n) : parseInt(n, 10)));
  return null;
};

const queryAll = async (ks_id) => {
  const items = [];
  let exclusiveStartKey;
  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: KB_CACHE_TABLE,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": { S: `ks#${ks_id}` } },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const it of resp.Items || []) {
      items.push(Object.fromEntries(Object.entries(it).map(([k, v]) => [k, fromDdb(v)])));
    }
    exclusiveStartKey = resp.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
};

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {  }, body: "" };
  }

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });

  if (!KB_CACHE_TABLE) return reply(500, { error: "KB_CACHE_TABLE env var not set" });

  const qs = event.queryStringParameters || {};
  const ks_id = qs.ks_id;
  if (!ks_id) return reply(400, { error: "ks_id query param required" });

  const denial = await checkKsRead(ks_id, auth.identity);
  if (denial) return denial;

  let rows;
  try {
    rows = await queryAll(ks_id);
  } catch (e) {
    return reply(500, { error: "ddb query failed", detail: String(e?.message || e) });
  }

  const assets = [];
  const entities = [];
  const events = [];
  const celebrities = [];
  let overview = null;
  for (const r of rows) {
    const sk = r.sk || "";
    if (sk.startsWith("ASSET#")) assets.push(r);
    else if (sk.startsWith("ENTITY#")) entities.push(r);
    else if (sk.startsWith("EVENT#")) events.push(r);
    else if (sk.startsWith("CELEBRITY#")) celebrities.push(r);
    else if (sk === "OVERVIEW") overview = r;
  }

  // Build node objects. Keep the payload lean — React Flow's data prop just
  // needs a label + a "kind" + a few stats. The UI hits a per-asset detail
  // endpoint (or future agent tool) for deep dives.
  const nodes = [];
  for (const a of assets) {
    nodes.push({
      id:   `asset#${a.asset_id}`,
      kind: "asset",
      data: {
        asset_id:    a.asset_id,
        title:       a.title || "untitled",
        one_liner:   a.one_liner || "",
        mood_tags:   a.mood_tags || [],
        role_hint:   a.role_hint || null,
        visual_style:a.visual_style || null,
      },
    });
  }
  for (const e of entities) {
    nodes.push({
      id:   `entity#${e.canonical || e.name}`,
      kind: "entity",
      data: {
        name:             e.name,
        canonical:        e.canonical,
        kind_label:       e.kind || "unknown",
        appearance_count: e.appearance_count || 0,
        asset_ids:        e.asset_ids || [],
        aliases:          e.aliases || [],
      },
    });
  }
  for (const ev of events) {
    nodes.push({
      id:   `event#${ev.event_id}`,
      kind: "event",
      data: {
        event_id:             ev.event_id,
        description:          ev.description || "",
        cluster_size:         ev.cluster_size || 0,
        confidence:           ev.confidence || 0,
        participating_assets: ev.participating_assets || [],
        mood_signature:       ev.mood_signature || [],
      },
    });
  }
  // Celebrity nodes — one per CELEBRITY# row, written by ks_rollup from
  // the assets table's celebrities[] field (in turn written by
  // index_faces via Rekognition RecognizeCelebrities).
  for (const c of celebrities) {
    nodes.push({
      id:   `celebrity#${c.name}`,
      kind: "celebrity",
      data: {
        name:             c.name,
        appearance_count: c.appearance_count || (c.asset_ids || []).length,
        max_confidence:   c.max_confidence || 0,
        asset_ids:        c.asset_ids || [],
      },
    });
  }

  // Build edges. Filter out edges that point at nodes we don't have (e.g. an
  // entity referencing an asset_id that wasn't in the cache).
  const assetIdSet = new Set(assets.map((a) => a.asset_id));
  const edges = [];
  for (const e of entities) {
    for (const aid of (e.asset_ids || [])) {
      if (!assetIdSet.has(aid)) continue;
      edges.push({
        id:     `e-ent#${e.canonical || e.name}-as#${aid}`,
        source: `entity#${e.canonical || e.name}`,
        target: `asset#${aid}`,
        kind:   "appears_in",
      });
    }
  }
  for (const ev of events) {
    for (const aid of (ev.participating_assets || [])) {
      if (!assetIdSet.has(aid)) continue;
      edges.push({
        id:     `e-ev#${ev.event_id}-as#${aid}`,
        source: `asset#${aid}`,
        target: `event#${ev.event_id}`,
        kind:   "participates_in",
      });
    }
  }
  // Celebrity → asset edges. Mirrors entity → asset.
  for (const c of celebrities) {
    for (const aid of (c.asset_ids || [])) {
      if (!assetIdSet.has(aid)) continue;
      edges.push({
        id:     `e-celeb#${c.name}-as#${aid}`,
        source: `celebrity#${c.name}`,
        target: `asset#${aid}`,
        kind:   "appears_in",
      });
    }
  }

  return reply(200, {
    ks_id,
    nodes,
    edges,
    overview: overview ? {
      asset_count:      overview.asset_count || 0,
      entity_count:     overview.entity_count || 0,
      celebrity_count:  overview.celebrity_count || 0,
      top_moods:        overview.top_moods || [],
      top_styles:       overview.top_styles || [],
      top_roles:        overview.top_roles || [],
      top_celebrities:  overview.top_celebrities || [],
      sample_titles:    overview.sample_titles || [],
    } : null,
    counts: { assets: assets.length, entities: entities.length, events: events.length, celebrities: celebrities.length, edges: edges.length },
  });
};
