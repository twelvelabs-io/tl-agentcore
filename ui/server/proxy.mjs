// Tiny proxy that hides the TL_API_KEY from the browser and pipes
// Server-Sent Events through transparently for streamed Jockey responses.
//
// Reads TL_API_KEY (and optional TL_BASE_URL) from the parent project's .env.
// Streams every request body through unchanged so multipart uploads work.

import express from "express";
import { Readable } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.resolve(__dirname, "..", "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const API_KEY = process.env.TL_API_KEY;
const BASE_URL = (process.env.TL_BASE_URL || "https://api.twelvelabs.io/v1.3").replace(/\/$/, "");
const PORT = Number(process.env.PROXY_PORT || 3001);

if (!API_KEY) {
  console.error("\nFATAL: TL_API_KEY not set. Looked at:", envPath);
  console.error("Set TL_API_KEY in that file or in the shell, then restart.\n");
  process.exit(1);
}

// IMPORTANT: no body-parsing middleware — we stream every body through.
const app = express();

app.get("/tl/_health", (_req, res) => {
  res.json({ ok: true, base: BASE_URL, key_prefix: API_KEY.slice(0, 12) + "..." });
});

const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade", "content-length",
]);

app.all(/^\/tl\/.*/, async (req, res) => {
  const targetPath = req.url.replace(/^\/tl/, "");
  const url = `${BASE_URL}${targetPath}`;

  // Forward request headers, drop hop-by-hop, force our key.
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) headers[k] = v.join(", ");
    else if (typeof v === "string") headers[k] = v;
  }
  headers["x-api-key"] = API_KEY;

  // Stream the body (multipart, JSON, anything) directly to upstream.
  // GET / HEAD have no body; everything else gets the raw stream.
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (hasBody) {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (e) {
    res.status(502).json({ error: "proxy fetch failed", detail: String(e) });
    return;
  }

  res.status(upstream.status);
  const ct = upstream.headers.get("content-type") || "";
  res.setHeader("content-type", ct);
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("x-accel-buffering", "no");

  if (ct.includes("text/event-stream") && upstream.body) {
    const reader = upstream.body.getReader();
    res.flushHeaders?.();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // Client disconnect; bail quietly.
    } finally {
      res.end();
    }
    return;
  }

  const text = await upstream.text();
  res.send(text);
});

app.listen(PORT, () => {
  console.log(`jockey-lab proxy → ${BASE_URL}  (key ${API_KEY.slice(0, 12)}...)  http://localhost:${PORT}`);
});
