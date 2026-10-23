// plugins — CRUD for customer-pluggable AgentCore Gateway targets.
//
// Each row in the plugins DDB table is one external data source the
// agent can call via MCP. On create/delete, this lambda calls the
// bedrock-agentcore-control SDK to add/remove the matching gateway
// target so the runtime discovers it the next time build_agent runs.
//
// Browser → CloudFront `/plugins*` → HTTP API Gateway → this lambda → DDB + Gateway.
//
// Two target types are supported:
//
//   LAMBDA   — target_type: "lambda". Original PR 1 shape. Caller
//              supplies lambda_arn + inlinePayload tool_schema. Gateway
//              invokes the Lambda directly using the gateway's IAM
//              role (no secret storage needed).
//
//   OPENAPI  — target_type: "openapi". Caller supplies endpoint_url +
//              openapi_schema (an OpenAPI 3.x JSON blob) + an auth
//              bundle. The lambda provisions an
//              aws_bedrockagentcore_api_key_credential_provider
//              (unless auth_type is "none"), configures the gateway
//              target to inject the credential on every outbound call,
//              and records the credential provider's ARN on the DDB
//              row so DELETE can tear it down.
//
// Four auth modes are supported on OpenAPI targets:
//
//   none        → no credential provider; endpoint must be publicly
//                 reachable (Function URL AuthType=NONE, etc.).
//   api_key     → header `{auth_header_name}: {value}`. Default
//                 auth_header_name is "X-API-Key".
//   bearer      → header `Authorization: Bearer {value}`. The gateway
//                 injects the "Bearer " prefix; the stored secret is
//                 just the token.
//   basic       → header `Authorization: Basic {base64(user:password)}`.
//                 The caller supplies auth_credential as a raw
//                 "user:password" string; the lambda base64-encodes it
//                 before storing. Gateway injects the "Basic " prefix.
//
// OAuth 2.0 lives behind a separate credential-provider resource
// (aws_bedrockagentcore_oauth2_credential_provider) and is not wired
// in this PR — follow-up.
//
// GET /plugins
//   Any authenticated user. Returns {plugins: [...]}. Secrets are
//   never returned; the credential_provider_arn is present (admins
//   can audit which Secrets Manager entry backs each row) but the
//   stored value is write-only.
//
// POST /plugins
//   Admin only. Body shape:
//     {
//       name, description,
//       target_type: "lambda" | "openapi",
//       // when lambda:
//       lambda_arn, tool_schema,
//       // when openapi:
//       endpoint_url, openapi_schema,
//       auth_type: "none" | "api_key" | "bearer" | "basic",
//       auth_credential?,            // required unless none
//       auth_header_name?,           // only used for api_key; defaults
//     }
//
// DELETE /plugins/{id}
//   Admin only. Removes gateway target (if present), credential
//   provider (if present), and then the DDB row. Idempotent.
//
// Admin is group membership in `ADMIN_GROUP_NAME` (default "admins").
import {
  BedrockAgentCoreControlClient,
  CreateApiKeyCredentialProviderCommand,
  CreateGatewayTargetCommand,
  DeleteApiKeyCredentialProviderCommand,
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
  const targetType  = String(body.target_type || "lambda").trim();

  if (!name || !/^[0-9a-zA-Z][-0-9a-zA-Z]{0,99}$/.test(name)) {
    return reply(400, { error: "name must match ^[0-9a-zA-Z][-0-9a-zA-Z]{0,99}$ (gateway target naming rule)" });
  }
  if (!["lambda", "openapi"].includes(targetType)) {
    return reply(400, { error: "target_type must be 'lambda' or 'openapi'" });
  }

  const pluginId  = randomUUID();
  const createdAt = new Date().toISOString();

  if (targetType === "lambda") {
    return await createLambdaPlugin({ pluginId, name, description, body, identity, createdAt });
  }
  return await createOpenApiPlugin({ pluginId, name, description, body, identity, createdAt });
}

async function createLambdaPlugin({ pluginId, name, description, body, identity, createdAt }) {
  const lambdaArn  = String(body.lambda_arn || "").trim();
  const toolSchema = body.tool_schema;

  if (!lambdaArn.startsWith("arn:aws:lambda:")) {
    return reply(400, { error: "lambda_arn must be a Lambda ARN" });
  }
  if (!toolSchema || typeof toolSchema !== "object") {
    return reply(400, { error: "tool_schema must be an object (gateway inlinePayload shape)" });
  }

  // Register the gateway target FIRST — if the SDK rejects the schema,
  // we don't want a dangling DDB row.
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
    target_type: { S: "lambda" },
    lambda_arn:  { S: lambdaArn },
    target_id:   { S: tgt.targetId },
    enabled:     { BOOL: true },
    created_by:  { S: identity.sub },
    created_at:  { S: createdAt },
  };
  await ddb.send(new PutItemCommand({ TableName: PLUGINS_TABLE, Item: item }));

  return reply(201, { plugin: rowToPlugin(item) });
}

// Auth-mode → (header name, prefix) mapping. The stored secret is just
// the credential value; Gateway concatenates `{prefix}{value}` into the
// outbound header on every call. For Basic, the caller supplies raw
// "user:password" and we base64-encode before storing so the stored
// value is already in header-ready form.
function authConfig(authType, body) {
  const t = String(authType || "none").toLowerCase();
  if (t === "none") {
    return { ok: true, mode: "none" };
  }
  if (t === "api_key") {
    const header = String(body.auth_header_name || "X-API-Key").trim();
    if (!/^[A-Za-z0-9-]{1,80}$/.test(header)) {
      return { ok: false, status: 400, message: "auth_header_name must be a plain HTTP header token" };
    }
    const cred = String(body.auth_credential || "");
    if (!cred) return { ok: false, status: 400, message: "auth_credential is required for api_key" };
    return { ok: true, mode: "api_key", header, prefix: "", stored: cred };
  }
  if (t === "bearer") {
    const cred = String(body.auth_credential || "");
    if (!cred) return { ok: false, status: 400, message: "auth_credential is required for bearer" };
    return { ok: true, mode: "bearer", header: "Authorization", prefix: "Bearer ", stored: cred };
  }
  if (t === "basic") {
    const cred = String(body.auth_credential || "");
    if (!cred.includes(":")) {
      return { ok: false, status: 400, message: "auth_credential for basic must be 'user:password'" };
    }
    const encoded = Buffer.from(cred, "utf8").toString("base64");
    return { ok: true, mode: "basic", header: "Authorization", prefix: "Basic ", stored: encoded };
  }
  return { ok: false, status: 400, message: `auth_type must be none|api_key|bearer|basic (got ${JSON.stringify(t)})` };
}

async function createOpenApiPlugin({ pluginId, name, description, body, identity, createdAt }) {
  const endpointUrl    = String(body.endpoint_url || "").trim();
  const openapiSchema  = body.openapi_schema;

  if (!/^https:\/\/[^\s]+$/i.test(endpointUrl)) {
    return reply(400, { error: "endpoint_url must be https://..." });
  }
  if (!openapiSchema || (typeof openapiSchema !== "string" && typeof openapiSchema !== "object")) {
    return reply(400, { error: "openapi_schema must be a JSON string or object (OpenAPI 3.x)" });
  }
  const payload = typeof openapiSchema === "string" ? openapiSchema : JSON.stringify(openapiSchema);
  if (payload.length > 100_000) {
    return reply(400, { error: "openapi_schema payload exceeds 100 KB (gateway inline limit)" });
  }

  const authCfg = authConfig(body.auth_type, body);
  if (!authCfg.ok) return reply(authCfg.status, { error: authCfg.message });

  // Provision the credential provider FIRST (if any), so a Gateway
  // CreateTarget failure doesn't leave a dangling provider.
  let credentialProviderArn = null;
  let credentialProviderName = null;
  if (authCfg.mode !== "none") {
    credentialProviderName = `${name}-${pluginId.slice(0, 8)}`;
    const cp = await gw.send(new CreateApiKeyCredentialProviderCommand({
      name: credentialProviderName,
      apiKey: authCfg.stored,
    }));
    credentialProviderArn = cp.credentialProviderArn;
  }

  const credentialProviderConfigurations = authCfg.mode === "none"
    ? [{ credentialProviderType: "GATEWAY_IAM_ROLE" }]
    : [{
        credentialProviderType: "API_KEY",
        credentialProvider: {
          apiKeyCredentialProvider: {
            providerArn:                credentialProviderArn,
            credentialLocation:         "HEADER",
            credentialParameterName:    authCfg.header,
            ...(authCfg.prefix ? { credentialPrefix: authCfg.prefix } : {}),
          },
        },
      }];

  let targetId;
  try {
    const tgt = await gw.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: GATEWAY_ID,
      name,
      description: description || undefined,
      credentialProviderConfigurations,
      targetConfiguration: {
        mcp: {
          openApiSchema: {
            inlinePayload: payload,
          },
        },
      },
    }));
    targetId = tgt.targetId;
  } catch (e) {
    // Roll back the credential provider so a schema-reject doesn't
    // leave a floating secret in Secrets Manager.
    if (credentialProviderArn) {
      try {
        await gw.send(new DeleteApiKeyCredentialProviderCommand({ name: credentialProviderName }));
      } catch (del) {
        console.warn(`rollback DeleteApiKeyCredentialProvider(${credentialProviderName}) failed:`, del?.message || del);
      }
    }
    throw e;
  }

  const item = {
    plugin_id:               { S: pluginId },
    name:                    { S: name },
    description:             { S: description || "" },
    target_type:             { S: "openapi" },
    endpoint_url:            { S: endpointUrl },
    auth_type:               { S: authCfg.mode },
    target_id:               { S: targetId },
    enabled:                 { BOOL: true },
    created_by:              { S: identity.sub },
    created_at:              { S: createdAt },
  };
  if (credentialProviderArn)  item.credential_provider_arn  = { S: credentialProviderArn };
  if (credentialProviderName) item.credential_provider_name = { S: credentialProviderName };
  if (authCfg.header)         item.auth_header_name = { S: authCfg.header };
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
      // Already gone? Fine. Anything else is logged but doesn't block
      // cleanup of downstream resources — orphan targets are a bigger
      // problem than orphan rows and we want delete to feel deterministic.
      console.warn(`DeleteGatewayTarget(${row.target_id}) failed:`, e?.message || e);
    }
  }

  if (row.credential_provider_name) {
    try {
      await gw.send(new DeleteApiKeyCredentialProviderCommand({
        name: row.credential_provider_name,
      }));
    } catch (e) {
      console.warn(`DeleteApiKeyCredentialProvider(${row.credential_provider_name}) failed:`, e?.message || e);
    }
  }

  await ddb.send(new DeleteItemCommand({
    TableName: PLUGINS_TABLE,
    Key: { plugin_id: { S: pluginId } },
  }));

  return reply(204, {});
}
