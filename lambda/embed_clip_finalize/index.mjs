// S3 ObjectCreated trigger on `embeddings/auto/<asset_id>/<ks_id>/<inv>/output.json`.
//
// Reads Bedrock Marengo's async-invoke output, keeps the clip-scope
// segments, and writes each one into the S3 Vectors index with the
// metadata the agent's vector_search tool filters by.
//
// The asset_id + ks_id are parsed from the key path. This avoids any
// out-of-band lookup; the upstream embed_clip_start lambda encodes them
// in the outputDataConfig.s3Uri prefix specifically so this side can
// rehydrate them deterministically.

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { S3VectorsClient, PutVectorsCommand } from "@aws-sdk/client-s3vectors";

const s3 = new S3Client({});
const s3v = new S3VectorsClient({});
const VECTOR_BUCKET = process.env.VECTOR_BUCKET_NAME;
const VECTOR_INDEX  = process.env.VECTOR_INDEX_NAME || "clips";
const CLIPS_BUCKET  = process.env.CLIPS_BUCKET_NAME;
const PUT_BATCH = 500;

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function parseKey(key) {
  // embeddings/auto/<asset_id>/<urlencoded ks_id>/<invocation_id>/output.json
  const parts = key.split("/");
  if (parts.length < 6 || parts[0] !== "embeddings" || parts[1] !== "auto") return null;
  if (parts[parts.length - 1] !== "output.json") return null;
  const asset_id = parts[2];
  const knowledge_store_id = decodeURIComponent(parts[3]);
  const invocation_id = parts[4];
  return { asset_id, knowledge_store_id, invocation_id };
}

export const handler = async (event) => {
  const records = event.Records || [];
  for (const rec of records) {
    const bucket = rec.s3?.bucket?.name;
    const key    = decodeURIComponent((rec.s3?.object?.key || "").replace(/\+/g, " "));
    if (!bucket || !key) continue;
    const meta = parseKey(key);
    if (!meta) { console.log(`skip non-output key: ${key}`); continue; }
    if (!VECTOR_BUCKET) { console.error("VECTOR_BUCKET_NAME not configured"); continue; }
    const { asset_id, knowledge_store_id } = meta;
    const s3_uri = `s3://${CLIPS_BUCKET || bucket}/clips/${asset_id}.mp4`;

    let body;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      body = JSON.parse(await streamToString(obj.Body));
    } catch (e) {
      console.error(`read output.json failed for ${key}: ${e}`);
      continue;
    }

    // Multi-vector indexing: one row per (clip, modality). Each segment
    // is tagged with its embedding_option so vector_search can run three
    // parallel filtered queries and fuse the results with intent-based
    // anchor weighting (see agent/tl_agentcore/agent.py).
    const vectors = [];
    for (let i = 0; i < (body.data || []).length; i++) {
      const seg = body.data[i];
      if (seg.embeddingScope !== "clip") continue;
      const emb = seg.embedding || [];
      if (!emb.length) continue;
      const modality = seg.embeddingOption || "visual";
      if (!["visual", "audio", "transcription"].includes(modality)) continue;
      const start_sec = Math.trunc(seg.startSec || 0);
      const end_sec   = Math.trunc(seg.endSec   || 0);
      vectors.push({
        key: `${asset_id}:${start_sec}:${end_sec}:${modality}:${i}`,
        data: { float32: emb },
        metadata: {
          asset_id,
          knowledge_store_id,
          start_sec,
          end_sec,
          s3_uri,
          embedding_option: modality,
        },
      });
    }
    if (!vectors.length) {
      console.log(`no clip-scope vectors in ${key}`);
      continue;
    }

    let written = 0;
    for (let i = 0; i < vectors.length; i += PUT_BATCH) {
      const batch = vectors.slice(i, i + PUT_BATCH);
      try {
        await s3v.send(new PutVectorsCommand({
          vectorBucketName: VECTOR_BUCKET,
          indexName: VECTOR_INDEX,
          vectors: batch,
        }));
        written += batch.length;
      } catch (e) {
        console.error(`PutVectors failed for ${asset_id}: ${e}`);
        break;
      }
    }
    console.log(`embedded asset=${asset_id} ks=${knowledge_store_id} vectors=${written}`);
  }
  return { ok: true };
};
