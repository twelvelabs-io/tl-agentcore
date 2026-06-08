// entity_reid_invoke_async — Step Functions Task: invoke the gdino async
// endpoint for one asset, wait for the S3 output object, return the
// output S3 URI to the next state.
//
// SageMaker Async Inference flow:
//   1. PutObject the request JSON to <async_in_prefix>/in.json
//   2. invoke_endpoint_async(EndpointName, InputLocation=...) →
//      returns { InferenceId, OutputLocation, FailureLocation }
//   3. Poll OutputLocation (HEAD on the S3 object) every 5s until 200,
//      or FailureLocation appears (in which case raise).
//   4. Return { output_location, asset_id } for EmbedPatches.
//
// One Lambda invocation handles end-to-end for a single asset; this
// keeps the state machine simple (no Wait/Choice loop). Lambda timeout
// is 15 min — enough for a warm endpoint (~30-60s) AND the first-time
// cold start (~5-10 min for TRT engine compile after scale-out).
//
// Input event (passed by the Map iterator):
//   {
//     "ks_id":       "ks_...",
//     "asset":       {
//       "asset_id":     "6a09...",
//       "video_s3_uri": "s3://<clips>/clips/<asset_id>.mp4",
//       "request":      { "text_prompt": "...", "fps": 2.0 },
//       "async_in_uri": "s3://<clips>/async-in/<exec>/<asset_id>/in.json",
//       "async_out_uri":"s3://<clips>/async-out/<exec>/<asset_id>/out.json"
//     }
//   }
// Output:
//   { asset_id, output_location, inference_id, elapsed_ms }

import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SageMakerRuntimeClient, InvokeEndpointAsyncCommand } from "@aws-sdk/client-sagemaker-runtime";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});
const smr = new SageMakerRuntimeClient({});

const ENDPOINT_NAME = process.env.GDINO_ENDPOINT_NAME;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const POLL_DEADLINE_MS = parseInt(process.env.POLL_DEADLINE_MS || "840000", 10); // 14 min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseS3 = (uri) => {
  if (!uri.startsWith("s3://")) throw new Error(`expected s3:// uri, got ${uri}`);
  const rest = uri.slice(5);
  const i = rest.indexOf("/");
  return { bucket: rest.slice(0, i), key: rest.slice(i + 1) };
};

const headExists = async (uri) => {
  const { bucket, key } = parseS3(uri);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") return false;
    throw e;
  }
};

export const handler = async (event) => {
  const t0 = Date.now();
  const { ks_id, asset } = event || {};
  if (!ENDPOINT_NAME) throw new Error("GDINO_ENDPOINT_NAME env var required");
  if (!ks_id || !asset) throw new Error("ks_id, asset required");

  const { asset_id, video_s3_uri, request, async_in_uri } = asset;
  if (!asset_id || !video_s3_uri || !request || !async_in_uri) {
    throw new Error("asset must have asset_id, video_s3_uri, request, async_in_uri");
  }
  // async_out_uri is intentionally NOT required — SageMaker generates the
  // output location dynamically (returned in the InvokeEndpointAsync
  // response below); list_assets used to predict it but no longer does.

  // 1. PutObject the request body. The container's /invocations route
  //    receives the raw bytes as the request body; SageMaker doesn't
  //    transform the S3 object, so this needs to be the literal JSON
  //    the FastAPI handler expects.
  //
  // Container uses ffmpeg/ffprobe which can't read s3:// URLs — they need
  // plain HTTPS. Presign a GET URL with a 1-hour TTL (generous; the async
  // endpoint cold-start can take 10+ min and we want headroom).
  const videoLoc = parseS3(video_s3_uri);
  const presigned_video_url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: videoLoc.bucket, Key: videoLoc.key }),
    { expiresIn: 3600 },
  );

  const body = {
    video_path:  presigned_video_url,
    text_prompt: request.text_prompt || "person.",
    fps:         request.fps || 2.0,
  };
  const inLoc = parseS3(async_in_uri);
  await s3.send(new PutObjectCommand({
    Bucket:      inLoc.bucket,
    Key:         inLoc.key,
    Body:        JSON.stringify(body),
    ContentType: "application/json",
  }));

  // 2. Invoke async. SageMaker returns immediately with InferenceId.
  //    OutputLocation in the response is the eventual JSON object path
  //    SageMaker will write upon completion — we override by passing
  //    InferenceId and using a deterministic OutputLocation under the
  //    endpoint's configured s3_output_path, OR by relying on
  //    EndpointConfig's s3_output_path with auto-generated suffix.
  //    We chose the latter (no override here), so we MUST use the
  //    OutputLocation returned by the API. Pass it back to Step Functions.
  const resp = await smr.send(new InvokeEndpointAsyncCommand({
    EndpointName:   ENDPOINT_NAME,
    InputLocation:  async_in_uri,
    ContentType:    "application/json",
    Accept:         "application/json",
    InferenceId:    `${asset_id.slice(0, 32)}-${Date.now()}`,
  }));
  const outputLocation  = resp.OutputLocation;
  const failureLocation = resp.FailureLocation;

  // 3. Poll. Check failure-location first to short-circuit on hard errors.
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (failureLocation && await headExists(failureLocation)) {
      // Read the failure body (small JSON), surface it.
      const { bucket, key } = parseS3(failureLocation);
      try {
        const o = await s3.send(new (await import("@aws-sdk/client-s3")).GetObjectCommand({ Bucket: bucket, Key: key }));
        const text = await o.Body.transformToString();
        throw new Error(`gdino async-failure: ${text.slice(0, 500)}`);
      } catch (e) {
        throw new Error(`gdino async-failure at ${failureLocation}: ${e.message}`);
      }
    }
    if (outputLocation && await headExists(outputLocation)) {
      return {
        asset_id,
        output_location: outputLocation,
        inference_id:    resp.InferenceId,
        elapsed_ms:      Date.now() - t0,
      };
    }
  }
  throw new Error(`gdino async timed out after ${(Date.now() - t0) / 1000}s waiting on ${outputLocation}`);
};
