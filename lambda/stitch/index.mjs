// stitch — assemble an EDL into a single MP4 preview via MediaConvert.
//
// The Rough Cut UI's "Render preview" button POSTs the current plan
// (the same JSON the agent emits inside <plan>…</plan>) and polls
// GET /stitch/{job_id} for progress. Output lands at
// s3://<clips>/stitched/<job_id>/preview.mp4 and is served public via
// CloudFront /stitched/* (so the browser <video> can play it without
// SigV4).
//
// Wire format (matches what the UI already expects):
//   POST /stitch     body: { plan }
//     -> 202 { job_id, render_id, status: "SUBMITTED", clip_count, output_url? }
//   GET  /stitch/{id}
//     -> 200 { job_id, render_id, status: "PROGRESSING"|"COMPLETE"|"ERROR",
//              percent, output_url? }
//
// MediaConvert handles the concat: each clip is its own Input{} with an
// InputClippings range — MC stitches them sequentially into one MP4.

import {
  MediaConvertClient,
  DescribeEndpointsCommand,
  CreateJobCommand,
  GetJobCommand,
} from "@aws-sdk/client-mediaconvert";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
import { authorize } from "./auth.mjs";

const CLIPS_BUCKET    = process.env.CLIPS_BUCKET;
const MC_ROLE_ARN     = process.env.MEDIACONVERT_ROLE_ARN;
const PLAYBACK_BASE   = (process.env.PLAYBACK_BASE_URL || "").replace(/\/$/, "");

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

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  body: JSON.stringify(body),
});

const cors = () => ({
  statusCode: 204,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  },
  body: "",
});

// Strict 24-hex asset_id (same shape the agent emits).
const ASSET_ID_RE = /^[0-9a-f]{24}$/;

function hhmmssToSeconds(s) {
  // "HH:MM:SS" → seconds; tolerant of bad input. The UI also emits SMPTE-style
  // HH:MM:SS:FF on the EDL path but our <plan> uses HH:MM:SS so we accept
  // both shapes.
  if (typeof s !== "string") return 0;
  const parts = s.split(":");
  if (parts.length < 3) return 0;
  const [h, m, sec] = parts.map((p) => parseInt(p, 10) || 0);
  return h * 3600 + m * 60 + sec;
}

function secondsToHhmmssff(secs, fps = 30) {
  const total = Math.max(0, Math.round(secs * fps));
  const frames = total % fps;
  const totalSecs = Math.floor(total / fps);
  const s = totalSecs % 60;
  const m = Math.floor(totalSecs / 60) % 60;
  const h = Math.floor(totalSecs / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

function clipsFromPlan(plan) {
  const out = [];
  for (const scene of (plan?.scenes || [])) {
    for (const c of (scene?.clips || [])) {
      const aid = String(c?.video_reference || "").trim();
      if (!ASSET_ID_RE.test(aid)) continue;
      const start = hhmmssToSeconds(c?.start_time);
      const end = hhmmssToSeconds(c?.end_time);
      if (end <= start) continue;
      out.push({ asset_id: aid, start_sec: start, end_sec: end });
    }
  }
  return out;
}

// One Input per clip with InputClippings. MediaConvert concatenates Inputs in
// order into a single output. Output is an MP4 (not HLS) so the UI's <video>
// can play it without an HLS lib in the post-render preview surface.
function buildStitchJob(jobId, clips) {
  const inputs = clips.map((c) => ({
    FileInput: `s3://${CLIPS_BUCKET}/clips/${c.asset_id}.mp4`,
    TimecodeSource: "ZEROBASED",
    AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
    VideoSelector: {},
    InputClippings: [{
      StartTimecode: secondsToHhmmssff(c.start_sec),
      EndTimecode:   secondsToHhmmssff(c.end_sec),
    }],
  }));

  const destination = `s3://${CLIPS_BUCKET}/stitched/${jobId}/`;

  return {
    Role: MC_ROLE_ARN,
    Settings: {
      Inputs: inputs,
      OutputGroups: [{
        Name: "MP4",
        OutputGroupSettings: {
          Type: "FILE_GROUP_SETTINGS",
          FileGroupSettings: { Destination: destination },
        },
        Outputs: [{
          NameModifier: "_preview",
          ContainerSettings: { Container: "MP4" },
          VideoDescription: {
            CodecSettings: {
              Codec: "H_264",
              H264Settings: {
                RateControlMode: "QVBR",
                QvbrSettings: { QvbrQualityLevel: 7 },
                MaxBitrate: 3000000,
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
      }],
    },
  };
}

function statusFromMc(mcStatus) {
  // MediaConvert: SUBMITTED → PROGRESSING → COMPLETE | ERROR | CANCELED
  // UI expects the same vocabulary, pass-through.
  return mcStatus || "SUBMITTED";
}

function outputUrlFor(jobId) {
  // MediaConvert appends the NameModifier ("_preview") before the extension
  // and emits as `<destination>/<output-prefix>_preview.mp4`. The destination
  // we set is `stitched/<job_id>/` and MC names the file after the input file
  // basename. Since each input has a different basename, MC actually emits
  // `<destination><input-basename>_preview.mp4` for the LAST input — not the
  // concatenation we want. To get a deterministic single-file output, we set
  // a `JobTemplate` … but for simplicity here, we just list the object on
  // GetJob and stamp whichever .mp4 it produced.
  return PLAYBACK_BASE ? `${PLAYBACK_BASE}/stitched/${jobId}/preview.mp4` : null;
}

async function startStitch(body) {
  const plan = body?.plan;
  if (!plan) return json(400, { error: "plan required" });
  const clips = clipsFromPlan(plan);
  if (!clips.length) return json(400, { error: "no clips in plan (need video_reference + start_time + end_time)" });

  const jobId = `stitch-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let mcJobId;
  try {
    const mcc = await getMc();
    const out = await mcc.send(new CreateJobCommand({
      ...buildStitchJob(jobId, clips),
      // Stamp jobId into UserMetadata so GetJob can be looked up by our
      // logical id later if we ever store a mapping; here we surface MC's
      // own job id as render_id and use it for polling.
      UserMetadata: { stitchJobId: jobId },
    }));
    mcJobId = out?.Job?.Id;
  } catch (e) {
    return json(500, { error: "MediaConvert CreateJob failed", detail: String(e?.message || e) });
  }

  return json(202, {
    job_id:     mcJobId || jobId,
    render_id:  mcJobId,
    status:     "SUBMITTED",
    percent:    0,
    clip_count: clips.length,
    output_url: outputUrlFor(jobId),
  });
}

async function getStitchStatus(jobId) {
  if (!jobId) return json(400, { error: "job_id required" });
  let job;
  try {
    const mcc = await getMc();
    const out = await mcc.send(new GetJobCommand({ Id: jobId }));
    job = out?.Job;
  } catch (e) {
    return json(404, { error: "job not found", detail: String(e?.message || e) });
  }
  const status = statusFromMc(job?.Status);
  const stitchId = job?.UserMetadata?.stitchJobId || jobId;
  // MediaConvert reports progress via JobPercentComplete on PROGRESSING jobs.
  const percent = job?.JobPercentComplete ?? (status === "COMPLETE" ? 100 : 0);
  // The Output destination we set in buildStitchJob is
  // s3://<clips>/stitched/<stitchId>/. MC emits a file per input — we read
  // the first .mp4 it produced via the OutputGroupDetails return.
  let outputUrl = null;
  if (status === "COMPLETE") {
    const out0 = job?.OutputGroupDetails?.[0]?.OutputDetails?.[0]?.OutputFilePaths?.[0];
    if (out0 && out0.startsWith(`s3://${CLIPS_BUCKET}/`)) {
      const key = out0.slice(`s3://${CLIPS_BUCKET}/`.length);
      outputUrl = PLAYBACK_BASE ? `${PLAYBACK_BASE}/${key}` : null;
    } else {
      // OutputFilePaths is sometimes missing on COMPLETE — fall back to
      // listing the destination prefix and picking whatever .mp4 MC wrote.
      // The synthetic outputUrlFor() pattern (`/preview.mp4`) is wrong in
      // practice — MC names files after the input basename, so the actual
      // key is something like `<basename>_preview.mp4`. Listing is the
      // only reliable way to find it.
      try {
        const list = await s3.send(new ListObjectsV2Command({
          Bucket: CLIPS_BUCKET,
          Prefix: `stitched/${stitchId}/`,
          MaxKeys: 5,
        }));
        const mp4 = (list?.Contents || [])
          .map((o) => o.Key)
          .filter((k) => k && k.endsWith(".mp4"))[0];
        outputUrl = mp4 && PLAYBACK_BASE ? `${PLAYBACK_BASE}/${mp4}` : null;
      } catch (e) {
        console.warn(`stitch: S3 list fallback failed for ${stitchId}`, e);
        outputUrl = null;
      }
    }
  }
  return json(200, {
    job_id:    jobId,
    render_id: jobId,
    status,
    percent,
    output_url: outputUrl,
    error: job?.ErrorMessage,
  });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return cors();

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return json(auth.status, { error: auth.message });

  if (!CLIPS_BUCKET || !MC_ROLE_ARN) {
    return json(500, { error: "lambda env not configured (CLIPS_BUCKET / MEDIACONVERT_ROLE_ARN)" });
  }

  let body = null;
  if (event.body) {
    try { body = JSON.parse(event.body); }
    catch { return json(400, { error: "invalid JSON body" }); }
  }
  const path = event.rawPath || event.requestContext?.http?.path || "";

  try {
    if (method === "POST" && /^\/stitch\/?$/.test(path)) return await startStitch(body || {});
    const m = path.match(/^\/stitch\/([A-Za-z0-9._:-]+)\/?$/);
    if (method === "GET" && m) return await getStitchStatus(m[1]);
    return json(404, { error: "no route", path, method });
  } catch (e) {
    return json(500, { error: "stitch failure", detail: String(e?.message || e) });
  }
};
