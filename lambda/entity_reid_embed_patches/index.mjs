// entity_reid_embed_patches — Step Functions Task: read the gdino async
// endpoint's output JSON (the ExtractPatchCandidatesResponse), Titan-embed
// each patch_b64 crop, upsert into the entity-patches S3 Vectors index.
//
// Input event:
//   {
//     "ks_id":           "ks_...",
//     "asset_id":        "6a09...",
//     "output_location": "s3://<clips>/async-out/<inference-id>.out"
//   }
// Output:
//   { asset_id, patches_embedded, elapsed_ms }
//
// Vector schema (S3 Vectors `entity-patches`):
//   key       = "<asset_id>#<instance_id>#<frame_ms>"
//   data      = Titan 1024-dim float32 embedding of patch_b64
//   metadata  = { asset_id, knowledge_store_id, instance_id, label,
//                 confidence, timestamp_s, shot_key, bbox_xyxy[] }

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, PutVectorsCommand } from "@aws-sdk/client-s3vectors";

const s3 = new S3Client({});
const br = new BedrockRuntimeClient({});
const s3v = new S3VectorsClient({});

const VECTOR_BUCKET = process.env.VECTOR_BUCKET_NAME;
const VECTOR_INDEX  = process.env.VECTOR_INDEX_ENTITY_PATCHES || "entity-patches";
const TITAN_MODEL   = process.env.TITAN_IMAGE_EMBED_MODEL_ID || "amazon.titan-embed-image-v1";

const parseS3 = (uri) => {
  if (!uri.startsWith("s3://")) throw new Error(`expected s3:// uri, got ${uri}`);
  const rest = uri.slice(5);
  const slash = rest.indexOf("/");
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
};

const titanEmbed = async (jpgB64) => {
  const body = JSON.stringify({
    inputImage: jpgB64,
    embeddingConfig: { outputEmbeddingLength: 1024 },
  });
  const resp = await br.send(new InvokeModelCommand({
    modelId: TITAN_MODEL,
    contentType: "application/json",
    accept: "application/json",
    body,
  }));
  const payload = JSON.parse(new TextDecoder().decode(resp.body));
  if (!payload?.embedding) throw new Error(`Titan returned no embedding: ${JSON.stringify(payload).slice(0, 200)}`);
  return payload.embedding;
};

export const handler = async (event) => {
  const t0 = Date.now();
  const { ks_id, asset_id, output_location } = event || {};
  if (!ks_id || !asset_id || !output_location) {
    throw new Error("ks_id, asset_id, output_location required");
  }
  if (!VECTOR_BUCKET) throw new Error("VECTOR_BUCKET_NAME env var required");

  // SageMaker writes the full response body to `<output_location>`; no
  // suffix path-joining needed (unlike the processing-job pattern).
  const { bucket, key } = parseS3(output_location);
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await obj.Body.transformToString();
  const response = JSON.parse(raw);
  const candidates = response.patch_candidates || [];

  if (!candidates.length) {
    return { asset_id, patches_embedded: 0, elapsed_ms: Date.now() - t0 };
  }

  const vectors = [];
  for (const pc of candidates) {
    const embedding = await titanEmbed(pc.patch_b64);
    vectors.push({
      key: `${asset_id}#${pc.instance_id}#${Math.round((pc.timestamp || 0) * 1000)}`,
      data: { float32: embedding },
      metadata: {
        asset_id,
        knowledge_store_id: ks_id,
        instance_id:        Number(pc.instance_id),
        label:              pc.label || "",
        confidence:         Number(pc.confidence || 0),
        timestamp_s:        Number(pc.timestamp || 0),
        shot_key:           pc.shot_key || "",
        bbox_xyxy:          (pc.bbox_xyxy || []).map(Number),
      },
    });
  }

  for (let i = 0; i < vectors.length; i += 500) {
    await s3v.send(new PutVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName:        VECTOR_INDEX,
      vectors:          vectors.slice(i, i + 500),
    }));
  }

  return { asset_id, patches_embedded: vectors.length, elapsed_ms: Date.now() - t0 };
};
