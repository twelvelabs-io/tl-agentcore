// kb_admin — AWS-native replacement for the TL knowledge-store + asset
// surfaces the UI used to hit through tl_proxy. Single lambda, HTTP API
// routing, Cognito-authenticated, DynamoDB-backed.
//
// Routes:
//   GET    /kb/knowledge-stores                          → list KSes
//   POST   /kb/knowledge-stores                          → { name, description } → create
//   GET    /kb/knowledge-stores/{ksId}                   → get
//   DELETE /kb/knowledge-stores/{ksId}                   → delete (assets in KS are NOT cascaded)
//   GET    /kb/knowledge-stores/{ksId}/items             → list assets in KS
//   POST   /kb/knowledge-stores/{ksId}/items             → { asset_id } → attach existing asset
//   DELETE /kb/knowledge-stores/{ksId}/items/{itemId}    → detach asset from KS (asset row stays)
//   GET    /kb/assets                                    → list assets (?knowledge_store_id=…, ?limit=N)
//   GET    /kb/assets/{assetId}                          → get one asset
//   DELETE /kb/assets/{assetId}                          → delete asset row + S3 mp4 + HLS bundle
//
// Notes:
//   - KS ids look like `ks_<uuidv7>`; asset ids are 24-hex like TL's were so the
//     existing agent toolchain (which validates with ASSET_ID_RE) keeps working.
//   - HLS playback URLs are CloudFront-fronted: https://<cf>/hls/<asset_id>/master.m3u8
//   - Asset rows are populated by the upload lambda after MediaConvert finishes;
//     this lambda only reads them.

import { DynamoDBClient, QueryCommand, ScanCommand, GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { authorize } from "./auth.mjs";

const ddb = new DynamoDBClient({});
const s3  = new S3Client({});

const KS_TABLE     = process.env.KS_TABLE;
const ASSETS_TABLE = process.env.ASSETS_TABLE;
const KB_CACHE     = process.env.KB_CACHE_TABLE;
const CLIPS_BUCKET = process.env.CLIPS_BUCKET;
const PLAYBACK_BASE = (process.env.PLAYBACK_BASE_URL || "").replace(/\/$/, "");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const cors = () => ({
  statusCode: 204,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-demo-password",
  },
  body: "",
});

// ─── DDB AttributeValue helpers ────────────────────────────────────────────
const toAv = (v) => {
  if (v === undefined || v === null) return { NULL: true };
  if (typeof v === "string") return { S: v };
  if (typeof v === "number") return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  if (Array.isArray(v))     return { L: v.map(toAv) };
  if (typeof v === "object") return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toAv(x)])) };
  return { S: String(v) };
};
const fromAv = (v) => {
  if (!v) return null;
  if ("S" in v)  return v.S;
  if ("N" in v)  return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  if ("NULL" in v) return null;
  if ("L" in v)  return v.L.map(fromAv);
  if ("M" in v)  return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromAv(x)]));
  if ("SS" in v) return [...v.SS];
  return null;
};
const itemToObj = (item) => Object.fromEntries(Object.entries(item || {}).map(([k, v]) => [k, fromAv(v)]));

// ─── Id generators ─────────────────────────────────────────────────────────
const ksId    = () => `ks_${randomUUID()}`;
// 24-char hex — same shape as TL's asset ids so the agent's ASSET_ID_RE still
// passes and operator URLs stay legible.
const assetId = () => {
  const buf = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString("hex");
};
const nowIso = () => new Date().toISOString();

// ─── KS handlers ───────────────────────────────────────────────────────────
async function listKnowledgeStores() {
  const out = await ddb.send(new ScanCommand({ TableName: KS_TABLE, Limit: 200 }));
  const rows = (out.Items || []).map(itemToObj);
  // Newest first by created_at when present.
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  // Map to the shape the UI's KS type expects (`_id`, `name`, etc.)
  const data = rows.map((r) => ({
    _id: r.ks_id,
    name: r.name,
    description: r.description,
    item_count: r.item_count || 0,
    created_at: r.created_at,
  }));
  return json(200, { data });
}

async function createKnowledgeStore(body) {
  const name = (body?.name || "").trim();
  if (!name) return json(400, { error: "name required" });
  const id = ksId();
  const ks = {
    ks_id: id,
    name,
    description: body?.description || "",
    item_count: 0,
    created_at: nowIso(),
  };
  await ddb.send(new PutItemCommand({
    TableName: KS_TABLE,
    Item: Object.fromEntries(Object.entries(ks).map(([k, v]) => [k, toAv(v)])),
    ConditionExpression: "attribute_not_exists(ks_id)",
  }));
  return json(200, { _id: id, name: ks.name, description: ks.description, item_count: 0, created_at: ks.created_at });
}

async function getKnowledgeStore(ksIdParam) {
  const out = await ddb.send(new GetItemCommand({
    TableName: KS_TABLE,
    Key: { ks_id: { S: ksIdParam } },
  }));
  if (!out.Item) return json(404, { error: "ks not found" });
  const r = itemToObj(out.Item);
  return json(200, { _id: r.ks_id, name: r.name, description: r.description, item_count: r.item_count || 0, created_at: r.created_at });
}

async function deleteKnowledgeStore(ksIdParam) {
  await ddb.send(new DeleteItemCommand({
    TableName: KS_TABLE,
    Key: { ks_id: { S: ksIdParam } },
  }));
  return json(200, { deleted: ksIdParam });
}

// ─── KS items (asset attach/detach) ───────────────────────────────────────
async function listKsItems(ksIdParam) {
  const out = await ddb.send(new QueryCommand({
    TableName: ASSETS_TABLE,
    IndexName: "by-ks",
    KeyConditionExpression: "knowledge_store_id = :k",
    ExpressionAttributeValues: { ":k": { S: ksIdParam } },
    ScanIndexForward: false,
  }));
  const data = (out.Items || []).map(itemToObj).map(rowToKsItem);
  return json(200, { data });
}

async function attachItem(ksIdParam, body) {
  const aid = body?.asset_id;
  if (!aid) return json(400, { error: "asset_id required" });
  await ddb.send(new UpdateItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: aid } },
    UpdateExpression: "SET knowledge_store_id = :k",
    ExpressionAttributeValues: { ":k": { S: ksIdParam } },
    ConditionExpression: "attribute_exists(asset_id)",
  }));
  // Return the canonical asset row in KSItem shape.
  return getItem(ksIdParam, aid);
}

async function detachItem(_ksIdParam, itemId) {
  // Items and assets are the same row here; "detach" clears the KS pointer
  // but keeps the asset (matches the prior TL semantics in api.ts comment).
  await ddb.send(new UpdateItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: itemId } },
    UpdateExpression: "REMOVE knowledge_store_id",
  }));
  return json(200, { detached: itemId });
}

async function getItem(_ksIdParam, itemId) {
  const out = await ddb.send(new GetItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: itemId } },
  }));
  if (!out.Item) return json(404, { error: "asset not found" });
  return json(200, rowToKsItem(itemToObj(out.Item)));
}

const rowToKsItem = (r) => ({
  _id:       r.asset_id,
  asset_id:  r.asset_id,
  filename:  r.filename || "",
  status:    r.status || "ready",
});

// ─── Asset handlers ────────────────────────────────────────────────────────
async function listAssets(qs) {
  const ks = qs.knowledge_store_id;
  const limit = parseInt(qs.limit || "200", 10);
  let items;
  if (ks) {
    const out = await ddb.send(new QueryCommand({
      TableName: ASSETS_TABLE,
      IndexName: "by-ks",
      KeyConditionExpression: "knowledge_store_id = :k",
      ExpressionAttributeValues: { ":k": { S: ks } },
      ScanIndexForward: false,
      Limit: limit,
    }));
    items = out.Items || [];
  } else {
    const out = await ddb.send(new ScanCommand({ TableName: ASSETS_TABLE, Limit: limit }));
    items = out.Items || [];
  }
  const assets = items.map(itemToObj).map(rowToAsset);
  return json(200, { data: assets, page_info: { total_results: assets.length } });
}

async function getAssetHandler(assetIdParam) {
  const out = await ddb.send(new GetItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: assetIdParam } },
  }));
  if (!out.Item) return json(404, { error: "asset not found" });
  return json(200, rowToAsset(itemToObj(out.Item)));
}

async function deleteAssetHandler(assetIdParam) {
  // Best-effort: blow away the row, the source mp4, and the HLS bundle.
  await ddb.send(new DeleteItemCommand({
    TableName: ASSETS_TABLE,
    Key: { asset_id: { S: assetIdParam } },
  }));
  try { await s3.send(new DeleteObjectCommand({ Bucket: CLIPS_BUCKET, Key: `clips/${assetIdParam}.mp4` })); } catch {}
  try {
    const ls = await s3.send(new ListObjectsV2Command({ Bucket: CLIPS_BUCKET, Prefix: `hls/${assetIdParam}/` }));
    const objs = (ls.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) await s3.send(new DeleteObjectsCommand({ Bucket: CLIPS_BUCKET, Delete: { Objects: objs } }));
  } catch {}
  return json(200, { deleted: assetIdParam });
}

const rowToAsset = (r) => ({
  _id:         r.asset_id,
  status:      r.status || "ready",
  filename:    r.filename,
  file_type:   r.file_type || "video/mp4",
  duration:    r.duration,
  size:        r.size,
  created_at:  r.created_at,
  hls: {
    manifest_url: r.hls_manifest_url || (PLAYBACK_BASE ? `${PLAYBACK_BASE}/hls/${r.asset_id}/master.m3u8` : undefined),
    status:       r.hls_status || (r.hls_manifest_url ? "ready" : "pending"),
  },
  thumbnail: {
    representative_url: r.thumbnail_url || (PLAYBACK_BASE ? `${PLAYBACK_BASE}/hls/${r.asset_id}/thumb_000001.jpg` : undefined),
    status:             r.thumbnail_status || (r.thumbnail_url ? "ready" : "pending"),
  },
});

// ─── Router ────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return cors();

  // /kb/* via API Gateway HTTP API
  const path = event.rawPath || event.requestContext?.http?.path || "";
  const auth = await authorize(event.headers || {});
  if (!auth.ok) return json(auth.status, { error: auth.message });

  let body = null;
  if (event.body) {
    try { body = JSON.parse(event.body); } catch { return json(400, { error: "invalid JSON body" }); }
  }
  const qs = event.queryStringParameters || {};

  try {
    // KS routes
    let m = path.match(/^\/kb\/knowledge-stores\/?$/);
    if (m) {
      if (method === "GET")  return await listKnowledgeStores();
      if (method === "POST") return await createKnowledgeStore(body || {});
    }
    m = path.match(/^\/kb\/knowledge-stores\/([^/]+)\/items\/([^/]+)\/?$/);
    if (m) {
      if (method === "DELETE") return await detachItem(m[1], m[2]);
      if (method === "GET")    return await getItem(m[1], m[2]);
    }
    m = path.match(/^\/kb\/knowledge-stores\/([^/]+)\/items\/?$/);
    if (m) {
      if (method === "GET")  return await listKsItems(m[1]);
      if (method === "POST") return await attachItem(m[1], body || {});
    }
    m = path.match(/^\/kb\/knowledge-stores\/([^/]+)\/?$/);
    if (m) {
      if (method === "GET")    return await getKnowledgeStore(m[1]);
      if (method === "DELETE") return await deleteKnowledgeStore(m[1]);
    }
    // Asset routes
    m = path.match(/^\/kb\/assets\/([^/]+)\/?$/);
    if (m) {
      if (method === "GET")    return await getAssetHandler(m[1]);
      if (method === "DELETE") return await deleteAssetHandler(m[1]);
    }
    m = path.match(/^\/kb\/assets\/?$/);
    if (m) {
      if (method === "GET") return await listAssets(qs);
    }
    return json(404, { error: "no route", path, method });
  } catch (e) {
    return json(500, { error: "kb_admin failure", detail: String(e?.message || e) });
  }
};

// asset id generator + nowIso are also surfaced for the upload-lambda which
// shares this module's id shape.
export { assetId, nowIso };
