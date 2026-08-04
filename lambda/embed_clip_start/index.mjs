// POST /upload/embed — promote an uploaded clip into the AWS-native
// pipeline. One server call covers: minting the asset_id, writing the
// asset row, copying bytes into the canonical clips/ prefix, starting
// the MediaConvert HLS transcode, and kicking off the Bedrock Marengo
// async embed. The browser only sees one round trip after the S3 PUT.
//
// Request body:  { "key": "uploads/<uuid>.mp4",
//                  "knowledge_store_id": "ks_...",
//                  "filename": "original.mp4" }   // filename optional
// Response 202:  { "asset_id": "...",
//                  "invocation_arn": "arn:...",
//                  "knowledge_store_id": "ks_...",
//                  "s3_uri": "s3://...mp4",
//                  "hls_manifest_url": "https://<cf>/hls/<asset_id>/master.m3u8",
//                  "mediaconvert_job_id": "..." }
//
// MediaConvert + Marengo run in parallel; the asset row's hls.status starts
// as "pending" and is flipped to "ready" by a separate S3-triggered lambda
// when the HLS master lands.

import {
  S3Client,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, StartAsyncInvokeCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { MediaConvertClient, DescribeEndpointsCommand, CreateJobCommand } from "@aws-sdk/client-mediaconvert";
import { randomBytes } from "node:crypto";
import { authorize } from "./auth.mjs";

const s3  = new S3Client({});
const br  = new BedrockRuntimeClient({});
const ddb = new DynamoDBClient({});

const BUCKET           = process.env.CLIPS_BUCKET_NAME;
const ACCOUNT_ID       = process.env.AWS_ACCOUNT_ID;
const MARENGO_MODEL_ID = process.env.MARENGO_BEDROCK_MODEL_ID || "twelvelabs.marengo-embed-3-0-v1:0";
const ASSETS_TABLE     = process.env.ASSETS_TABLE;
const MC_ROLE_ARN      = process.env.MEDIACONVERT_ROLE_ARN;
const PLAYBACK_BASE    = (process.env.PLAYBACK_BASE_URL || "").replace(/\/$/, "");

// MediaConvert is account-region scoped; resolve the endpoint once per
// container, then re-create the client against that URL.
let mc = null;
async function getMc() {
  if (mc) return mc;
  const probe = new MediaConvertClient({});
  const { Endpoints } = await probe.send(new DescribeEndpointsCommand({}));
  const url = Endpoints?.[0]?.Url;
  if (!url) throw new Error("MediaConvert: no endpoint discovered for this region");
  mc = new MediaConvertClient({ endpoint: url });
  return mc;
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// 24-char hex asset id. Keeps the agent's ASSET_ID_RE happy and matches
// the legacy TL-side shape so operator URLs stay legible.
function assetId() { return randomBytes(12).toString("hex"); }
function nowIso()  { return new Date().toISOString(); }

const toAv = (v) => {
  if (v === undefined || v === null) return { NULL: true };
  if (typeof v === "string")  return { S: v };
  if (typeof v === "number")  return { N: String(v) };
  if (typeof v === "boolean") return { BOOL: v };
  return { S: String(v) };
};

// Build a single-rendition HLS job. One AVC 720p output is enough for the
// demo player; bump in production to ladder more bitrates.
function hlsJobSettings(asset, srcKey) {
  const destination = `s3://${BUCKET}/hls/${asset}/`;
  return {
    Role: MC_ROLE_ARN,
    Settings: {
      Inputs: [{
        FileInput: `s3://${BUCKET}/${srcKey}`,
        TimecodeSource: "ZEROBASED",
        AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
        VideoSelector: {},
      }],
      OutputGroups: [
        {
          Name: "HLS",
          OutputGroupSettings: {
            Type: "HLS_GROUP_SETTINGS",
            HlsGroupSettings: {
              Destination: destination,
              SegmentLength: 6,
              MinSegmentLength: 0,
              ManifestDurationFormat: "INTEGER",
              StreamInfResolution: "INCLUDE",
            },
          },
          Outputs: [{
            NameModifier: "_master",
            ContainerSettings: {
              Container: "M3U8",
              M3u8Settings: { AudioPids: [482], VideoPid: 481, PmtPid: 480 },
            },
            VideoDescription: {
              CodecSettings: {
                Codec: "H_264",
                H264Settings: {
                  RateControlMode: "QVBR",
                  QvbrSettings: { QvbrQualityLevel: 7 },
                  MaxBitrate: 3500000,
                  GopSize: 60,
                  FramerateControl: "INITIALIZE_FROM_SOURCE",
                  SceneChangeDetect: "TRANSITION_DETECTION",
                },
              },
              ScalingBehavior: "DEFAULT",
              Height: 720,
            },
            AudioDescriptions: [{
              CodecSettings: {
                Codec: "AAC",
                AacSettings: { Bitrate: 96000, CodingMode: "CODING_MODE_2_0", SampleRate: 48000 },
              },
            }],
          }],
        },
        {
          Name: "Thumbnails",
          OutputGroupSettings: {
            Type: "FILE_GROUP_SETTINGS",
            FileGroupSettings: { Destination: destination },
          },
          Outputs: [{
            NameModifier: "_thumb",
            ContainerSettings: { Container: "RAW" },
            VideoDescription: {
              CodecSettings: {
                Codec: "FRAME_CAPTURE",
                FrameCaptureSettings: {
                  // Capture one frame every 5 seconds, up to 180 (~15 min
                  // coverage). Lets the UI map any clip start_time to a
                  // real captured frame across the full source duration
                  // (instead of just the first 2 min). hls_finalize still
                  // picks the frame closest to 25% of duration as the
                  // default thumbnail.
                  FramerateNumerator: 1,
                  FramerateDenominator: 5,
                  MaxCaptures: 180,
                  Quality: 80,
                },
              },
              Width: 1280,
              Height: 720,
            },
          }],
        },
        // A normalized MP4 sibling to the HLS bundle. Bedrock Pegasus
        // sometimes rejects the source mp4 with
        // "Unprocessable video, please check the video codec or duration"
        // when the source has unusual codecs or container quirks
        // (low-res / non-standard bitrate / missing keyframes — common in
        // sports reference clips and dailies). MediaConvert re-encodes
        // everything into a single mp4 (H.264 baseline + AAC) at
        // `s3://<clips>/clips/<asset_id>_normalized.mp4`, which Pegasus
        // accepts reliably. asset_profile tries the original first and
        // falls back to this one on ValidationException.
        {
          Name: "NormalizedMP4",
          OutputGroupSettings: {
            Type: "FILE_GROUP_SETTINGS",
            FileGroupSettings: { Destination: `s3://${BUCKET}/clips/` },
          },
          Outputs: [{
            // Output filename will be `<asset_id>_normalized.mp4`.
            NameModifier: "_normalized",
            ContainerSettings: { Container: "MP4" },
            VideoDescription: {
              CodecSettings: {
                Codec: "H_264",
                H264Settings: {
                  RateControlMode: "QVBR",
                  QvbrSettings: { QvbrQualityLevel: 6 },
                  MaxBitrate: 1500000,
                  GopSize: 60,
                  CodecProfile: "MAIN",
                  CodecLevel: "AUTO",
                  FramerateControl: "INITIALIZE_FROM_SOURCE",
                  SceneChangeDetect: "TRANSITION_DETECTION",
                },
              },
              ScalingBehavior: "DEFAULT",
              Height: 540,
            },
            AudioDescriptions: [{
              CodecSettings: {
                Codec: "AAC",
                AacSettings: { Bitrate: 96000, CodingMode: "CODING_MODE_2_0", SampleRate: 48000 },
              },
            }],
          }],
        },
      ],
    },
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {  }, body: "" };
  }
  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });

  if (!BUCKET || !ACCOUNT_ID || !ASSETS_TABLE || !MC_ROLE_ARN) {
    return reply(500, { error: "lambda env not configured (CLIPS_BUCKET_NAME / ACCOUNT_ID / ASSETS_TABLE / MEDIACONVERT_ROLE_ARN)" });
  }

  let req;
  try { req = JSON.parse(event.body || "{}"); }
  catch { return reply(400, { error: "invalid JSON body" }); }

  const uploadKey = String(req.key || "");
  const ksId      = String(req.knowledge_store_id || "");
  const filename  = String(req.filename || uploadKey.split("/").pop() || "");
  if (!uploadKey || !ksId) {
    return reply(400, { error: "key and knowledge_store_id are required" });
  }
  if (!uploadKey.startsWith("uploads/")) {
    return reply(400, { error: "key must live under the uploads/ prefix" });
  }
  // The presign lambda writes keys as `uploads/<caller.sub>/<uuid>.<ext>`.
  // Reject anything that doesn't include the current caller's sub so a
  // different signed-in user can't finalize someone else's upload by
  // guessing the uuid. Legacy keys without a sub segment (from before
  // this check landed) are still accepted so pre-existing pending
  // uploads don't wedge.
  const expectedPrefix = `uploads/${auth.identity.sub}/`;
  const parts = uploadKey.split("/");
  const looksNamespaced = parts.length >= 3;
  if (looksNamespaced && !uploadKey.startsWith(expectedPrefix)) {
    return reply(403, { error: "upload key does not belong to caller" });
  }

  // Mint the asset_id server-side so the row exists before any downstream
  // step references it.
  const aid     = assetId();
  const destKey = `clips/${aid}.mp4`;
  const destUri = `s3://${BUCKET}/${destKey}`;
  // MediaConvert always prefixes output filenames with the source basename
  // (`clips/<aid>.mp4` → basename `<aid>`) then appends the NameModifier.
  // So the master playlist is `<aid>_master.m3u8`, not `master_master.m3u8`.
  const hlsUrl  = PLAYBACK_BASE ? `${PLAYBACK_BASE}/hls/${aid}/${aid}_master.m3u8` : null;
  const thumbUrl = PLAYBACK_BASE ? `${PLAYBACK_BASE}/hls/${aid}/${aid}_thumb.0000000.jpg` : null;

  // 1. Copy uploads/<key> → clips/<asset_id>.mp4 (canonical Bedrock path).
  try {
    await s3.send(new CopyObjectCommand({
      Bucket: BUCKET,
      Key: destKey,
      CopySource: `${BUCKET}/${uploadKey}`,
      ContentType: "video/mp4",
      MetadataDirective: "REPLACE",
    }));
  } catch (e) {
    return reply(500, { error: "copy failed", detail: String(e) });
  }
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: destKey }));
  } catch (e) {
    return reply(500, { error: "verify failed", detail: String(e) });
  }

  // 2. Write the assets row up front so the UI can immediately list it
  //    with status "pending"; MediaConvert + Marengo flip fields later.
  const created = nowIso();
  try {
    await ddb.send(new PutItemCommand({
      TableName: ASSETS_TABLE,
      Item: {
        asset_id:           toAv(aid),
        knowledge_store_id: toAv(ksId),
        filename:           toAv(filename),
        file_type:          toAv("video/mp4"),
        created_at:         toAv(created),
        status:             toAv("pending"),
        hls_status:         toAv("pending"),
        hls_manifest_url:   hlsUrl ? toAv(hlsUrl) : { NULL: true },
        thumbnail_status:   toAv("pending"),
        thumbnail_url:      thumbUrl ? toAv(thumbUrl) : { NULL: true },
        // Ownership: kb_admin's canRead/canMutate uses this. Set once
        // at create; kb_admin's attach/detach never rewrites it.
        owner_sub:          toAv(auth.identity.sub),
      },
      ConditionExpression: "attribute_not_exists(asset_id)",
    }));
  } catch (e) {
    return reply(500, { error: "assets put failed", detail: String(e) });
  }

  // 3. Kick off MediaConvert HLS transcode (parallel with Marengo).
  let mcJobId = null;
  try {
    const mcClient = await getMc();
    const out = await mcClient.send(new CreateJobCommand(hlsJobSettings(aid, destKey)));
    mcJobId = out?.Job?.Id || null;
  } catch (e) {
    // Non-fatal: row already says hls_status=pending. Surface inline so
    // the operator can see the failure during demo runs.
    console.warn("MediaConvert CreateJob failed", e);
  }

  // 4. Bedrock Marengo async-invoke. Output prefix encodes asset_id + ks_id
  //    so the finalize lambda (S3-triggered on output.json) can pick them
  //    back up without an external lookup.
  const outputPrefix = `s3://${BUCKET}/embeddings/auto/${aid}/${encodeURIComponent(ksId)}/`;
  let invocation;
  try {
    invocation = await br.send(new StartAsyncInvokeCommand({
      modelId: MARENGO_MODEL_ID,
      modelInput: {
        inputType: "video",
        video: {
          mediaSource: {
            s3Location: { uri: destUri, bucketOwner: ACCOUNT_ID },
          },
          embeddingOption: ["visual", "audio", "transcription"],
        },
      },
      outputDataConfig: {
        s3OutputDataConfig: { s3Uri: outputPrefix },
      },
    }));
  } catch (e) {
    return reply(500, { error: "StartAsyncInvoke failed", detail: String(e) });
  }

  return reply(202, {
    asset_id:             aid,
    invocation_arn:       invocation.invocationArn,
    knowledge_store_id:   ksId,
    s3_uri:               destUri,
    hls_manifest_url:     hlsUrl,
    mediaconvert_job_id:  mcJobId,
  });
};
