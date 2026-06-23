// S3-triggered: hls/<asset_id>/<asset_id>_master.m3u8 lands → flip the
// matching assets row from "pending" to "ready", and backfill the size /
// duration fields the UI's right-rail details panel reads.
//
// Trigger: aws_s3_bucket_notification on prefix=hls/ + suffix=_master.m3u8

import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const ddb = new DynamoDBClient({});
const s3  = new S3Client({});
const lam = new LambdaClient({});
const ASSETS_TABLE = process.env.ASSETS_TABLE;
const CLIPS_BUCKET = process.env.CLIPS_BUCKET;
const INDEX_FACES_LAMBDA = process.env.INDEX_FACES_LAMBDA;

// Read the HLS master manifest and sum its #EXTINF segment durations.
// Works for both single-rendition (our case — one .m3u8 is itself the
// segment list) and multi-rendition masters (which would reference a child
// playlist whose first variant we'd then fetch). We handle the multi-
// variant case by recursing once into the first variant URI we see.
async function readDurationSec(masterKey) {
  const txt = await readM3u8(masterKey);
  // Multi-variant master: pick the first .m3u8 referenced as a variant.
  const variant = txt.split(/\r?\n/).find((l) => l && !l.startsWith("#") && l.endsWith(".m3u8"));
  const playlistTxt = variant ? await readM3u8(joinKey(masterKey, variant)) : txt;
  let total = 0;
  for (const line of playlistTxt.split(/\r?\n/)) {
    const m = line.match(/^#EXTINF:([0-9.]+)/);
    if (m) total += parseFloat(m[1]);
  }
  return total > 0 ? Math.round(total) : null;
}

async function readM3u8(key) {
  const out = await s3.send(new GetObjectCommand({ Bucket: CLIPS_BUCKET, Key: key }));
  const stream = out.Body;
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function joinKey(masterKey, relative) {
  // master = "hls/<aid>/<aid>_master.m3u8"; relative = "playlist.m3u8" or
  // an absolute URL. We only handle relative — MC outputs are always
  // sibling files in the same prefix.
  if (relative.startsWith("http")) return relative;
  const dir = masterKey.split("/").slice(0, -1).join("/");
  return `${dir}/${relative}`;
}

export const handler = async (event) => {
  for (const rec of event.Records || []) {
    const key = decodeURIComponent(String(rec.s3?.object?.key || "").replace(/\+/g, " "));
    // MediaConvert names outputs as `<inputBasename><nameModifier>.<ext>`.
    // Our inputs are `clips/<asset_id>.mp4` and we set NameModifier=`_master`,
    // so the master playlist is `hls/<asset_id>/<asset_id>_master.m3u8`.
    const m = key.match(/^hls\/([0-9a-f]{24})\/[0-9a-f]{24}_master\.m3u8$/);
    if (!m) continue;
    const assetId = m[1];

    // Best-effort enrichment: size + duration. Both are nice-to-have for
    // the UI; failures here shouldn't block the status flip.
    let size = null, duration = null;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: CLIPS_BUCKET, Key: `clips/${assetId}.mp4` }));
      if (typeof head?.ContentLength === "number") size = head.ContentLength;
    } catch (e) {
      console.warn(`hls_finalize: HEAD clips/${assetId}.mp4 failed`, e);
    }
    try {
      duration = await readDurationSec(key);
    } catch (e) {
      console.warn(`hls_finalize: duration parse failed for ${key}`, e);
    }

    // Thumbnail: MediaConvert captures one frame every 5 s, up to 24 frames.
    // Pick the one closest to 25% of the clip's duration so the still skips
    // black / color bars / agency logos. Falls back to frame 0 if we
    // couldn't determine duration.
    const THUMB_CADENCE_SEC = 5;
    const MAX_CAPTURES      = 24;
    let thumbIdx = 0;
    if (duration != null && duration > 0) {
      const target = duration * 0.25;
      thumbIdx = Math.max(0, Math.min(MAX_CAPTURES - 1, Math.floor(target / THUMB_CADENCE_SEC)));
    }
    const thumbName = `${assetId}_thumb.${String(thumbIdx).padStart(7, "0")}.jpg`;
    const thumbUrl = process.env.PLAYBACK_BASE_URL
      ? `${process.env.PLAYBACK_BASE_URL.replace(/\/$/, "")}/hls/${assetId}/${thumbName}`
      : null;

    // Build the UpdateItem. We always set hls_status + status; size +
    // duration only if we successfully derived them; thumbnail_url only
    // if PLAYBACK_BASE_URL is configured.
    const setParts = ["hls_status = :r", "#s = :r", "thumbnail_status = :r"];
    const exprValues = { ":r": { S: "ready" } };
    if (size != null) {
      setParts.push("#sz = :sz");
      exprValues[":sz"] = { N: String(size) };
    }
    if (duration != null) {
      setParts.push("#du = :du");
      exprValues[":du"] = { N: String(duration) };
    }
    if (thumbUrl) {
      setParts.push("thumbnail_url = :tu");
      exprValues[":tu"] = { S: thumbUrl };
    }

    let ksId = null;
    try {
      const resp = await ddb.send(new UpdateItemCommand({
        TableName: ASSETS_TABLE,
        Key: { asset_id: { S: assetId } },
        UpdateExpression: "SET " + setParts.join(", "),
        ExpressionAttributeNames: {
          "#s":  "status",
          "#sz": "size",
          "#du": "duration",
        },
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }));
      ksId = resp?.Attributes?.knowledge_store_id?.S || null;
      console.log(`hls_finalize: ${assetId} → ready (size=${size}, duration=${duration}, thumb=${thumbIdx})`);
    } catch (e) {
      console.warn(`hls_finalize: update failed for ${assetId}`, e);
    }

    // Fire IndexFaces async — the index_faces lambda samples N frames
    // from hls/<asset>/, IndexFaces them into the per-KS Rekognition
    // collection. InvocationType=Event so we don't block hls_finalize
    // on the ~5-30 s Rekognition pass. Best-effort; an Invoke failure
    // here doesn't reverse the status flip.
    if (INDEX_FACES_LAMBDA && ksId) {
      try {
        await lam.send(new InvokeCommand({
          FunctionName:   INDEX_FACES_LAMBDA,
          InvocationType: "Event",
          Payload:        Buffer.from(JSON.stringify({ ks_id: ksId, asset_id: assetId })),
        }));
        console.log(`hls_finalize: queued index_faces for ${assetId} (ks=${ksId})`);
      } catch (e) {
        console.warn(`hls_finalize: index_faces invoke failed for ${assetId}`, e);
      }
    } else if (!ksId) {
      console.warn(`hls_finalize: ks_id missing for ${assetId}; skipping index_faces`);
    }
  }
  return { ok: true };
};
