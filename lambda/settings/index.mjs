// settings — view/edit the system prompts the agent + ingest pipeline use.
//
// The defaults are baked into the lambda from `defaults.json`, generated
// by scripts/sync_default_prompts.py at deploy time. Overrides are stored
// globally (one row per prompt_id) in the kb_cache DDB table under
// pk = "settings#prompts", sk = "<prompt_id>".
//
// The agent runtime + asset_profile lambda each read the corresponding
// override row at invocation time and fall back to their baked default
// when the row is absent. "Reset to default" here just deletes the row.
//
// Routes:
//   GET    /settings/prompts                → { agent_system: { default, current, overridden }, pegasus_profile: {...} }
//   PUT    /settings/prompts/{id}           → { text } writes override
//   DELETE /settings/prompts/{id}           → removes override (reset)

import { readFileSync } from "node:fs";
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { authorize, authorizeAdmin } from "./auth.mjs";

const ddb = new DynamoDBClient({});
const KB_CACHE = process.env.KB_CACHE_TABLE;
const PROMPT_PK = "settings#prompts";

// Bundled defaults — sync_default_prompts.py writes this at deploy time.
const DEFAULTS = JSON.parse(readFileSync(new URL("./defaults.json", import.meta.url), "utf-8"));
const PROMPT_IDS = Object.keys(DEFAULTS);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const cors = () => ({
  statusCode: 204,
  headers: {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  },
  body: "",
});

async function readOverride(promptId) {
  const out = await ddb.send(new GetItemCommand({
    TableName: KB_CACHE,
    Key: { pk: { S: PROMPT_PK }, sk: { S: promptId } },
  }));
  if (!out.Item?.text?.S) return null;
  return {
    text: out.Item.text.S,
    updated_at: out.Item.updated_at?.N ? Number(out.Item.updated_at.N) : null,
    updated_by: out.Item.updated_by?.S || null,
  };
}

async function listAll() {
  // One Query is fine — only 2 rows under this PK.
  const overrides = {};
  for (const id of PROMPT_IDS) {
    overrides[id] = await readOverride(id);
  }
  const result = {};
  for (const id of PROMPT_IDS) {
    const def = DEFAULTS[id];
    const ov  = overrides[id];
    result[id] = {
      label:       def.label,
      description: def.description,
      source:      def.source,
      default:     def.text,
      current:     ov?.text ?? def.text,
      overridden:  Boolean(ov),
      updated_at:  ov?.updated_at ?? null,
      updated_by:  ov?.updated_by ?? null,
    };
  }
  return result;
}

async function writeOverride(promptId, text, identity) {
  await ddb.send(new PutItemCommand({
    TableName: KB_CACHE,
    Item: {
      pk:         { S: PROMPT_PK },
      sk:         { S: promptId },
      text:       { S: text },
      updated_at: { N: String(Math.floor(Date.now() / 1000)) },
      updated_by: { S: identity?.username || identity?.sub || "unknown" },
    },
  }));
}

async function deleteOverride(promptId) {
  await ddb.send(new DeleteItemCommand({
    TableName: KB_CACHE,
    Key: { pk: { S: PROMPT_PK }, sk: { S: promptId } },
  }));
}

// ── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path   = event.rawPath || event.requestContext?.http?.path || "";

  if (method === "OPTIONS") return cors();

  // GET is read-only — any signed-in user can view the current prompts.
  // PUT/DELETE mutate global state that every subsequent agent run
  // reads, so they require the `admins` group.
  const needsAdmin = method === "PUT" || method === "DELETE";
  const auth = needsAdmin
    ? await authorizeAdmin(event.headers || {})
    : await authorize(event.headers || {});
  if (!auth.ok) return json(auth.status, { error: auth.message });

  // GET /settings/prompts
  if (method === "GET" && /^\/settings\/prompts\/?$/.test(path)) {
    try {
      const prompts = await listAll();
      return json(200, { prompts });
    } catch (e) {
      console.error("settings: list failed", e);
      return json(500, { error: String(e?.message || e) });
    }
  }

  const idMatch = path.match(/^\/settings\/prompts\/([a-z_]+)\/?$/);
  if (!idMatch) return json(404, { error: `unknown route ${method} ${path}` });
  const promptId = idMatch[1];
  if (!PROMPT_IDS.includes(promptId)) return json(404, { error: `unknown prompt id "${promptId}"` });

  // PUT /settings/prompts/{id}
  if (method === "PUT") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "body must be valid JSON" });
    }
    const text = body.text;
    if (typeof text !== "string" || !text.trim()) {
      return json(400, { error: "body.text must be a non-empty string" });
    }
    if (text.length > 64_000) {
      return json(400, { error: "prompt is too long (max 64K chars)" });
    }
    try {
      await writeOverride(promptId, text, auth.identity);
      const prompts = await listAll();
      return json(200, { prompts });
    } catch (e) {
      console.error("settings: write failed", e);
      return json(500, { error: String(e?.message || e) });
    }
  }

  // DELETE /settings/prompts/{id}  (= reset to default)
  if (method === "DELETE") {
    try {
      await deleteOverride(promptId);
      const prompts = await listAll();
      return json(200, { prompts });
    } catch (e) {
      console.error("settings: delete failed", e);
      return json(500, { error: String(e?.message || e) });
    }
  }

  return json(405, { error: `method ${method} not allowed on ${path}` });
};
