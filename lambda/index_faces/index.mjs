// index_faces — sample N frames per asset, IndexFaces against a per-KS
// Rekognition collection. Lazy-creates the collection on first call.
//
// Step 1 of the v0.4 hybrid (Rekognition primary). Auto-triggered after
// hls_finalize in step 4; for now it's invoked manually or by the
// scripts/backfill_rekognition.py one-shot.
//
// Event shape (either):
//   { ks_id, asset_id }                  — single asset
//   { ks_id, asset_ids: ["...", ...] }   — batch (e.g. backfill)
//
// Env vars:
//   STACK_FQNAME           collection_id derived as `<fqname>-ks-<ks_id>`
//   CLIPS_BUCKET_NAME      hls/<asset_id>/<asset_id>_thumb.NNNNNNN.jpg lives here
//   FRAMES_PER_ASSET       default 4

import { RekognitionClient, IndexFacesCommand, CreateCollectionCommand } from "@aws-sdk/client-rekognition";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const rek = new RekognitionClient({});
const s3 = new S3Client({});

const STACK_FQNAME = process.env.STACK_FQNAME;
const CLIPS_BUCKET = process.env.CLIPS_BUCKET_NAME;
const FRAMES_PER_ASSET = parseInt(process.env.FRAMES_PER_ASSET || "4", 10);

if (!STACK_FQNAME) throw new Error("STACK_FQNAME env var required");
if (!CLIPS_BUCKET) throw new Error("CLIPS_BUCKET_NAME env var required");

export const handler = async (event) => {
  const ks_id = event?.ks_id;
  if (!ks_id) throw new Error("ks_id required");
  const asset_ids = event.asset_ids || (event.asset_id ? [event.asset_id] : []);
  if (!asset_ids.length) throw new Error("asset_id or asset_ids required");

  const collection_id = `${STACK_FQNAME}-ks-${ks_id}`;
  await ensureCollection(collection_id);

  let facesIndexed = 0;
  let assetsProcessed = 0;
  const failures = [];

  for (const asset_id of asset_ids) {
    const keys = await sampleThumbKeys(asset_id, FRAMES_PER_ASSET);
    if (!keys.length) {
      failures.push({ asset_id, reason: "no_thumb_frames" });
      continue;
    }
    for (const key of keys) {
      try {
        const resp = await rek.send(new IndexFacesCommand({
          CollectionId: collection_id,
          Image: { S3Object: { Bucket: CLIPS_BUCKET, Name: key } },
          ExternalImageId: asset_id,
          DetectionAttributes: ["DEFAULT"],
          MaxFaces: 10,
          QualityFilter: "AUTO",
        }));
        facesIndexed += (resp.FaceRecords || []).length;
      } catch (e) {
        const code = e?.name || e?.Code || "Unknown";
        // No face in this frame is normal — keep going.
        if (code === "InvalidParameterException") continue;
        failures.push({ asset_id, key, error: code, message: e?.message?.slice(0, 200) });
      }
    }
    assetsProcessed += 1;
  }

  return {
    ks_id,
    collection_id,
    assets_processed: assetsProcessed,
    faces_indexed: facesIndexed,
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
