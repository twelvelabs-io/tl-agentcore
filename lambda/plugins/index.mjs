// plugins — CRUD for customer-pluggable AgentCore Gateway targets.
//
// Each row in the plugins DDB table is one external data source the
// agent can call via MCP. On create/delete, this lambda calls the
// bedrock-agentcore-control SDK to add/remove the matching gateway
// target so the runtime discovers it the next time build_agent runs.
//
// Browser → CloudFront `/plugins*` → HTTP API Gateway → this lambda → DDB + Gateway.
//
// GET /plugins
//   Any authenticated user. Returns {plugins: [{plugin_id, name,
//   description, lambda_arn, enabled, created_by, created_at, target_id?}]}.
//
// POST /plugins
//   Admin only. Body: {name, description, lambda_arn, tool_schema}.
//   `tool_schema` is the gateway-target inlinePayload shape, passed
//   through to CreateGatewayTarget verbatim (see
//   infra/plugin-echo-target.tf for an example). Response: 201 with
//   the created row, including the gateway's target_id.
//
// DELETE /plugins/{id}
//   Admin only. Removes the gateway target (if present) and then the
//   DDB row. Idempotent: a missing target is not an error.
//
// Admin is group membership in `ADMIN_GROUP_NAME` (default "admins")
// on the Cognito pool.
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import { authorize } from "./auth.mjs";

const ddb = new DynamoDBClient({});
const gw  = new BedrockAgentCoreControlClient({});

const PLUGINS_TABLE = process.env.PLUGINS_TABLE;
const GATEWAY_ID    = process.env.GATEWAY_ID;
const ADMIN_GROUP   = process.env.ADMIN_GROUP_NAME || "admins";

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function isAdmin(identity) {
  return Array.isArray(identity?.groups) && identity.groups.includes(ADMIN_GROUP);
}

function fromDdb(v) {
  if (v == null) return null;
  if ("S"    in v) return v.S;
  if ("N"    in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  if ("NULL" in v) return null;
  if ("L"    in v) return v.L.map(fromDdb);
  if ("M"    in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromDdb(x)]));
  return null;
}

function rowToPlugin(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, fromDdb(v)]));
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {}, body: "" };
  }

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });
  const identity = auth.identity;

  const method = event.requestContext?.http?.method;
  const path   = event.rawPath || "";

  try {
    if (method === "GET" && path === "/plugins") {
      return await listPlugins();
    }
    if (method === "POST" && path === "/plugins") {
      if (!isAdmin(identity)) return reply(403, { error: "admins only" });
      return await createPlugin(event, identity);
    }
    const deleteMatch = method === "DELETE" && /^\/plugins\/[^/]+$/.test(path);
    if (deleteMatch) {
      if (!isAdmin(identity)) return reply(403, { error: "admins only" });
      const pluginId = decodeURIComponent(path.split("/").pop());
      return await deletePlugin(pluginId);
    }
    return reply(404, { error: `no route: ${method} ${path}` });
  } catch (err) {
    console.error("plugins handler failed:", err);
    return reply(500, { error: String(err?.message || err) });
  }
};

async function listPlugins() {
  const out = await ddb.send(new ScanCommand({ TableName: PLUGINS_TABLE }));
  const plugins = (out.Items || []).map(rowToPlugin);
  plugins.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  return reply(200, { plugins });
}

async function createPlugin(event, identity) {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "body must be JSON" });
  }

  const name        = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const lambdaArn   = String(body.lambda_arn || "").trim();
  const toolSchema  = body.tool_schema;

  if (!name || !/^[0-9a-zA-Z][-0-9a-zA-Z]{0,99}$/.test(name)) {
    return reply(400, { error: "name must match ^[0-9a-zA-Z][-0-9a-zA-Z]{0,99}$ (gateway target naming rule)" });
  }
  if (!lambdaArn.startsWith("arn:aws:lambda:")) {
    return reply(400, { error: "lambda_arn must be a Lambda ARN" });
  }
  if (!toolSchema || typeof toolSchema !== "object") {
    return reply(400, { error: "tool_schema must be an object (gateway inlinePayload shape)" });
  }

  const pluginId = randomUUID();
  const createdAt = new Date().toISOString();

  // Register the gateway target FIRST — if the SDK rejects the
  // schema, we don't want a dangling DDB row.
  const tgt = await gw.send(new CreateGatewayTargetCommand({
    gatewayIdentifier: GATEWAY_ID,
    name,
    description: description || undefined,
    credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn,
          toolSchema: { inlinePayload: Array.isArray(toolSchema) ? toolSchema : [toolSchema] },
        },
      },
    },
  }));

  const item = {
    plugin_id:   { S: pluginId },
    name:        { S: name },
    description: { S: description || "" },
    lambda_arn:  { S: lambdaArn },
    target_id:   { S: tgt.targetId },
    enabled:     { BOOL: true },
    created_by:  { S: identity.sub },
    created_at:  { S: createdAt },
  };
  await ddb.send(new PutItemCommand({ TableName: PLUGINS_TABLE, Item: item }));

  return reply(201, { plugin: rowToPlugin(item) });
}

async function deletePlugin(pluginId) {
  const got = await ddb.send(new GetItemCommand({
    TableName: PLUGINS_TABLE,
    Key: { plugin_id: { S: pluginId } },
  }));
  if (!got.Item) {
    return reply(404, { error: `no plugin: ${pluginId}` });
  }
  const row = rowToPlugin(got.Item);

  if (row.target_id) {
    try {
      await gw.send(new DeleteGatewayTargetCommand({
        gatewayIdentifier: GATEWAY_ID,
        targetId:          row.target_id,
      }));
    } catch (e) {
      // Already gone? Fine. Anything else is logged but doesn't
      // block cleanup of the DDB row — orphan targets are a bigger
      // problem than orphan rows and we want the UI's delete to feel
      // deterministic.
      console.warn(`DeleteGatewayTarget(${row.target_id}) failed:`, e?.message || e);
    }
  }

  await ddb.send(new DeleteItemCommand({
    TableName: PLUGINS_TABLE,
    Key: { plugin_id: { S: pluginId } },
  }));

  return reply(204, {});
}
