// Generic forwarder: /tl/<rest> → https://api.twelvelabs.io/v1.3/<rest>
//
// Reads the TL API key from Secrets Manager (60s in-memory cache) and injects
// it as x-api-key. Supports JSON GET / POST / DELETE / PATCH. Multipart
// uploads aren't supported here; do them from a dev environment that talks
// to api.twelvelabs.io directly.
//
// Auth: Cognito access token (Authorization: Bearer <jwt>). Anything else 401.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { authorize } from "./auth.mjs";

const sm = new SecretsManagerClient({});
let cachedKey;
let cachedKeyAt = 0;
const KEY_TTL_MS = 60_000;

async function getApiKey() {
  if (cachedKey && Date.now() - cachedKeyAt < KEY_TTL_MS) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.TL_API_KEY_SECRET }));
  cachedKey = r.SecretString;
  cachedKeyAt = Date.now();
  return cachedKey;
}

const BASE = process.env.TL_BASE_URL || "https://api.twelvelabs.io/v1.3";

function reply(statusCode, body, contentType = "application/json") {
  return {
    statusCode,
    headers: { "content-type": contentType, "access-control-allow-origin": "*" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: { "access-control-allow-origin": "*" }, body: "" };
  }

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });

  // Path comes in as /tl/<rest>; strip the /tl prefix when forwarding.
  const fullPath = event.requestContext?.http?.path || event.rawPath || "";
  const rest = fullPath.replace(/^\/tl/, "");
  const url = `${BASE}${rest}${event.rawQueryString ? "?" + event.rawQueryString : ""}`;

  let key;
  try { key = await getApiKey(); }
  catch (e) { return reply(500, { error: "TL_API_KEY load failed", detail: String(e) }); }

  const fwdHeaders = { "x-api-key": key };
  const ct = event.headers?.["content-type"] || event.headers?.["Content-Type"];
  if (ct) fwdHeaders["content-type"] = ct;

  let body;
  if (event.body && event.requestContext?.http?.method !== "GET" && event.requestContext?.http?.method !== "HEAD") {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: event.requestContext?.http?.method || "GET",
      headers: fwdHeaders,
      body,
    });
  } catch (e) {
    return reply(502, { error: "fetch failed", detail: String(e) });
  }

  const respCt = upstream.headers.get("content-type") || "application/json";
  const text = await upstream.text();
  return reply(upstream.status, text, respCt);
};
