// graph_backfill — one-shot job that rebuilds the graph from the
// existing kb_cache + rights DDB rows.
//
// Fires from Terraform's `aws_lambda_invocation` on every apply where
// the graph or the backfill code hash changes. Two steps:
//
//   1. Force-invoke ks_rollup for every KS. ks_rollup honours a `force`
//      flag that bypasses its "OVERVIEW newer than latest ASSET#" skip
//      so it always dual-writes to the graph even when the DDB rows
//      are already up-to-date. This populates every (Asset, Entity,
//      Event, Celebrity, MoodTag, Style, Role) node + edge.
//
//   2. Sync the rights table into the graph. For every DDB row in
//      `rights`, MERGE a Rights node keyed by asset_id and a COVERS
//      edge (Rights → Asset). The COVERS edge carries the licensing
//      window + territory + usage summary from the row so a downstream
//      query can filter by clearance without a second DDB read.
//
// Idempotent — every write is a MERGE. Safe to run repeatedly.

import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { NeptuneGraphClient, ExecuteQueryCommand } from "@aws-sdk/client-neptune-graph";

const ddb = new DynamoDBClient({});
const lam = new LambdaClient({});
const GRAPH_ID = process.env.GRAPH_ID;
const graph = GRAPH_ID ? new NeptuneGraphClient({}) : null;

const KS_TABLE       = process.env.KS_TABLE;
const RIGHTS_TABLE   = process.env.RIGHTS_TABLE;
const KS_ROLLUP_ARN  = process.env.KS_ROLLUP_ARN;
const ASSETS_TABLE   = process.env.ASSETS_TABLE;

const fromAv = (v) => {
  if (v == null) return null;
  if ("S" in v) return v.S;
  if ("N" in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  if ("L" in v) return v.L.map(fromAv);
  if ("M" in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromAv(x)]));
  if ("SS" in v) return [...v.SS];
  return null;
};

async function scanAll(table, projection) {
  const rows = [];
  let last;
  do {
    const params = {
      TableName: table,
      ExclusiveStartKey: last,
    };
    if (projection) params.ProjectionExpression = projection;
    const r = await ddb.send(new ScanCommand(params));
    for (const it of r.Items || []) rows.push(Object.fromEntries(Object.entries(it).map(([k, v]) => [k, fromAv(v)])));
    last = r.LastEvaluatedKey;
  } while (last);
  return rows;
}

async function forceRollupEveryKs() {
  const ksRows = await scanAll(KS_TABLE, "ks_id");
  console.log(`graph_backfill: forcing rollup on ${ksRows.length} KSes`);
  const results = [];
  // Sequential — parallel Invokes could hammer Bedrock throttles on
  // the ks_rollup Claude-haiku event-clustering step. Sequential is
  // slow but predictable for a one-shot backfill.
  for (const { ks_id } of ksRows) {
    if (!ks_id) continue;
    try {
      const resp = await lam.send(new InvokeCommand({
        FunctionName:   KS_ROLLUP_ARN,
        InvocationType: "RequestResponse",
        Payload:        Buffer.from(JSON.stringify({ ks_id, force: true })),
      }));
      const payload = resp.Payload ? Buffer.from(resp.Payload).toString("utf8") : "";
      results.push({ ks_id, ok: resp.StatusCode < 300, payload: payload.slice(0, 200) });
    } catch (e) {
      console.warn(`graph_backfill: ks_rollup failed for ${ks_id}`, e);
      results.push({ ks_id, ok: false, error: String(e?.message || e) });
    }
  }
  return results;
}

// ─── Rights sync ─────────────────────────────────────────────────────
// Rights rows are per-asset. To create edges we need to know which KS
// each asset belongs to (Rights is a KS-scoped node), so we cross-
// reference against the assets table.
async function readAssetKsMap() {
  const rows = await scanAll(ASSETS_TABLE, "asset_id,knowledge_store_id");
  const map = new Map();
  for (const r of rows) {
    if (r.asset_id && r.knowledge_store_id) map.set(r.asset_id, r.knowledge_store_id);
  }
  return map;
}

async function syncRights() {
  if (!graph || !GRAPH_ID || !RIGHTS_TABLE) return { skipped: true };
  const [rightsRows, assetKs] = await Promise.all([
    scanAll(RIGHTS_TABLE),
    readAssetKsMap(),
  ]);
  // Not every field will exist on every row — the projection above
  // uses generic aliases so we can safely map missing keys to null.
  // The rights table's field names in this stack: territory, window,
  // usage, region, expires_at. Any subset present is written.
  const toGraph = [];
  for (const r of rightsRows) {
    const aid = r.asset_id;
    if (!aid) continue;
    const ksId = assetKs.get(aid);
    if (!ksId) continue;
    toGraph.push({
      asset_id:  aid,
      ks_id:     ksId,
      territory: r.territory || r.region || "",
      window:    r.window || "",
      usage:     r.usage || "",
      expires:   r.expires_at || "",
    });
  }
  if (!toGraph.length) return { covers_written: 0 };

  await graph.send(new ExecuteQueryCommand({
    graphIdentifier: GRAPH_ID,
    language: "OPEN_CYPHER",
    queryString: `
      UNWIND $rows AS row
      MATCH (a:Asset {ks_id: row.ks_id, asset_id: row.asset_id})
      MERGE (r:Rights {ks_id: row.ks_id, asset_id: row.asset_id})
      SET r.territory = row.territory,
          r.window    = row.window,
          r.usage     = row.usage,
          r.expires   = row.expires
      MERGE (r)-[:COVERS]->(a)
    `,
    parameters: { rows: toGraph },
    planCache: "AUTO",
  })).then((o) => o.payload && o.payload.transformToString());

  return { covers_written: toGraph.length };
}

export const handler = async () => {
  const startedAt = Date.now();
  const rollup = await forceRollupEveryKs();
  const okCount = rollup.filter((r) => r.ok).length;
  console.log(`graph_backfill: rollup phase done ${okCount}/${rollup.length}`);

  let rights;
  try { rights = await syncRights(); }
  catch (e) {
    console.warn("graph_backfill: rights sync failed", e);
    rights = { ok: false, error: String(e?.message || e) };
  }
  const durationMs = Date.now() - startedAt;
  console.log(`graph_backfill: done in ${durationMs}ms`);
  return { ok: true, rollup_count: rollup.length, rollup_ok: okCount, rights, duration_ms: durationMs };
};
