// index_faces — sample N frames per asset, run IndexFaces +
// RecognizeCelebrities. Lazy-creates the per-KS Rekognition collection
// on first call. Persists face_count + celebrities[] to the assets row
// so the UI can surface them in the KS overview + KnowledgeGraph tabs.
//
// Auto-triggered by hls_finalize after every upload. Can also be
// invoked in batch mode by scripts/backfill_rekognition.py.
//
// Event shape (either):
//   { ks_id, asset_id }                  — single asset
//   { ks_id, asset_ids: ["...", ...] }   — batch
//
// Env vars:
//   STACK_FQNAME            collection_id = `<fqname>-ks-<ks_id>`
//   CLIPS_BUCKET_NAME       hls/<asset_id>/<asset_id>_thumb.NNNNNNN.jpg lives here
//   ASSETS_TABLE            persist face_count + celebrities[] back here
//   FRAMES_PER_ASSET        default 4
//   MIN_CELEB_CONFIDENCE    default 85.0

import {
  RekognitionClient, IndexFacesCommand, CreateCollectionCommand,
  RecognizeCelebritiesCommand,
} from "@aws-sdk/client-rekognition";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const rek = new RekognitionClient({});
const s3  = new S3Client({});
const ddb = new DynamoDBClient({});

const STACK_FQNAME       = process.env.STACK_FQNAME;
const CLIPS_BUCKET       = process.env.CLIPS_BUCKET_NAME;
const ASSETS_TABLE       = process.env.ASSETS_TABLE;
const FRAMES_PER_ASSET   = parseInt(process.env.FRAMES_PER_ASSET || "4", 10);
const MIN_CELEB_CONF     = parseFloat(process.env.MIN_CELEB_CONFIDENCE || "85.0");

if (!STACK_FQNAME) throw new Error("STACK_FQNAME env var required");
if (!CLIPS_BUCKET) throw new Error("CLIPS_BUCKET_NAME env var required");

export const handler = async (event) => {
  const ks_id = event?.ks_id;
  if (!ks_id) throw new Error("ks_id required");
  const asset_ids = event.asset_ids || (event.asset_id ? [event.asset_id] : []);
  if (!asset_ids.length) throw new Error("asset_id or asset_ids required");

  const collection_id = `${STACK_FQNAME}-ks-${ks_id}`;
  await ensureCollection(collection_id);

  let totalFacesIndexed = 0;
  let totalCelebsFound  = 0;
  let assetsProcessed   = 0;
  const failures = [];

  for (const asset_id of asset_ids) {
    const keys = await sampleThumbKeys(asset_id, FRAMES_PER_ASSET);
    if (!keys.length) {
      failures.push({ asset_id, reason: "no_thumb_frames" });
      continue;
    }
    let faceCount = 0;
    const celebMap = new Map(); // name → {name, confidence}

    for (const key of keys) {
      // IndexFaces — stores face vectors in the per-KS collection.
      try {
        const resp = await rek.send(new IndexFacesCommand({
          CollectionId: collection_id,
          Image: { S3Object: { Bucket: CLIPS_BUCKET, Name: key } },
          ExternalImageId: asset_id,
          DetectionAttributes: ["DEFAULT"],
          MaxFaces: 10,
          QualityFilter: "AUTO",
        }));
        faceCount += (resp.FaceRecords || []).length;
      } catch (e) {
        const code = e?.name || e?.Code || "Unknown";
        if (code !== "InvalidParameterException") {
          failures.push({ asset_id, key, op: "IndexFaces", error: code, message: e?.message?.slice(0, 200) });
        }
      }

      // RecognizeCelebrities — only persisted to the assets row, not
      // indexed in the collection. Cheap ($0.001/image) and the chips
      // they produce are the most legible signal in the KS view.
      try {
        const resp = await rek.send(new RecognizeCelebritiesCommand({
          Image: { S3Object: { Bucket: CLIPS_BUCKET, Name: key } },
        }));
        for (const c of (resp.CelebrityFaces || [])) {
          const name = c?.Name;
          const conf = c?.MatchConfidence ?? 0;
          if (!name || conf < MIN_CELEB_CONF) continue;
          const cur = celebMap.get(name);
          if (!cur || conf > cur.confidence) celebMap.set(name, { name, confidence: conf });
        }
      } catch (e) {
        const code = e?.name || e?.Code || "Unknown";
        if (code !== "InvalidParameterException") {
          failures.push({ asset_id, key, op: "RecognizeCelebrities", error: code, message: e?.message?.slice(0, 200) });
        }
      }
    }

    const celebrities = Array.from(celebMap.values()).sort((a, b) => b.confidence - a.confidence);
    totalFacesIndexed += faceCount;
    totalCelebsFound  += celebrities.length;

    // Persist face_count + celebrities[] back to the assets row.
    if (ASSETS_TABLE) {
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: ASSETS_TABLE,
          Key: { asset_id: { S: asset_id } },
          UpdateExpression: "SET face_count = :fc, celebrities = :celebs",
          ExpressionAttributeValues: {
            ":fc":     { N: String(faceCount) },
            ":celebs": { L: celebrities.map((c) => ({ M: {
              name:       { S: c.name },
              confidence: { N: String(c.confidence) },
            } })) },
          },
        }));
      } catch (e) {
        failures.push({ asset_id, op: "UpdateItem", error: e?.name, message: e?.message?.slice(0, 200) });
      }
    }

    assetsProcessed += 1;
  }

  return {
    ks_id,
    collection_id,
    assets_processed:  assetsProcessed,
    faces_indexed:     totalFacesIndexed,
    celebrities_found: totalCelebsFound,
    failures,
  };
};

async function ensureCollection(collection_id) {
  try {
    await rek.send(new CreateCollectionCommand({ CollectionId: collection_id }));
  } catch (e) {
    if (e?.name !== "ResourceAlreadyExistsException") throw e;
  }
}

async function sampleThumbKeys(asset_id, n) {
  const prefix = `hls/${asset_id}/`;
  const resp = await s3.send(new ListObjectsV2Command({ Bucket: CLIPS_BUCKET, Prefix: prefix }));
  const keys = (resp.Contents || [])
    .map((o) => o.Key)
    .filter((k) => k.includes("_thumb.") && /\.(jpg|jpeg|png)$/i.test(k))
    .sort();
  if (keys.length <= n) return keys;
  const step = keys.length / n;
  return Array.from({ length: n }, (_, i) => keys[Math.floor(i * step)]);
}
