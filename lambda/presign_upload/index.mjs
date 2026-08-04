// POST /upload/presign — issue a one-shot S3 PUT + GET URL pair so the
// browser can upload a media file directly to S3 (bypassing the 10MB API
// Gateway payload cap), and TwelveLabs can ingest it from the GET URL on
// its end.
//
// Request body:  { "filename": "MyMovie.mp4", "content_type": "video/mp4" }
// Response 200:  { "key": "uploads/<uuid>.mp4", "put_url": "...", "get_url": "..." }
//
// Auth: Cognito access token (Authorization: Bearer <jwt>); same authorizer
// as tl_proxy.

import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { authorize } from "./auth.mjs";

const s3 = new S3Client({});
const BUCKET = process.env.CLIPS_BUCKET_NAME;
const PUT_TTL = 600;         // 10 min — operator picks file, picks file, uploads
const GET_TTL = 60 * 60;     // 1 h — TL pulls the bytes after asset create

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function safeExt(filename) {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename || "");
  if (!m) return "mp4";
  const ext = m[1].toLowerCase();
  // Restrict to media extensions we expect to ingest. Belt and braces; S3
  // doesn't care, but a wrong extension here misleads downstream tooling.
  return ["mp4", "mov", "m4v", "mkv", "webm", "avi"].includes(ext) ? ext : "mp4";
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {  }, body: "" };
  }
  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });
  if (!BUCKET) return reply(500, { error: "CLIPS_BUCKET_NAME not configured" });

  let req;
  try {
    req = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "invalid JSON body" });
  }
  const filename = String(req.filename || "");
  const contentType = String(req.content_type || "video/mp4");
  if (!filename) return reply(400, { error: "filename is required" });

  const ext = safeExt(filename);
  // Namespace the presigned key under the caller's Cognito sub so the
  // finalize step (embed_clip_start) can verify the same caller owns
  // the key it's being asked to copy — a different signed-in user
  // can't finalize someone else's still-pending upload by guessing
  // the uuid.
  const key = `uploads/${auth.identity.sub}/${randomUUID()}.${ext}`;

  let putUrl, getUrl;
  try {
    putUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: PUT_TTL },
    );
    getUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      { expiresIn: GET_TTL },
    );
  } catch (e) {
    return reply(500, { error: "presign failed", detail: String(e) });
  }

  return reply(200, { key, put_url: putUrl, get_url: getUrl, content_type: contentType });
};
