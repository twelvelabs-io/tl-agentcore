// chat lambda — WebSocket handler for the tl-agentcore demo UI.
//
// Two flows reach this lambda over the WebSocket:
//
//  1. mode === "agentcore"  →  invoke the AgentCore Runtime (Strands agent
//                              container). The actual work runs in an
//                              async self-invoke because runs can take
//                              60-300s and API Gateway WS has a hard 30s
//                              integration cap.
//
//  2. mode === "jockey"     →  passthrough to TwelveLabs /v1.3/responses
//                              for the Jockey-managed-orchestrator
//                              comparison demo.
//
// Auth: $connect verifies a Cognito access token from the URL query string
// (browsers can't set headers on a WS open). Once the connection is up,
// every message rides on it.

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { authorize } from "./auth.mjs";

// Multi-step AgentCore runs routinely take 120-240s — far past the SDK's
// default 180s socket timeout. Lift to 280s so we use the full lambda
// timeout (300s) before either layer cuts us off.
const acc = new BedrockAgentCoreClient({
  requestHandler: new NodeHttpHandler({
    socketTimeout:     280_000,
    connectionTimeout:  10_000,
  }),
});
const lambdaClient = new LambdaClient({});
const decoder = new TextDecoder();

export const handler = async (event) => {
  const routeKey = event.requestContext?.routeKey;
  if (routeKey === "$connect")    return handleConnect(event);
  if (routeKey === "$disconnect") return { statusCode: 200 };
  if (routeKey === "$default")    return handleWsMessage(event);
  // Async self-invocation for long-running AgentCore work.
  if (event.async_task === "agentcore") return handleAgentCoreAsync(event);
  return { statusCode: 400, body: "unrecognized event shape" };
};

async function handleConnect(event) {
  const qs = event.queryStringParameters || {};
  const token = qs.token || qs.t;
  const fakeHeaders = token ? { authorization: `Bearer ${token}` } : {};
  const auth = await authorize(fakeHeaders);
  if (!auth.ok) {
    console.warn("ws connect denied:", auth.message);
    return { statusCode: 401, body: auth.message };
  }
  return { statusCode: 200 };
}

async function handleWsMessage(event) {
  const ctx = event.requestContext;
  const apigw = new ApiGatewayManagementApiClient({
    endpoint: `https://${ctx.domainName}/${ctx.stage}`,
  });
  const post = (obj) =>
    apigw.send(new PostToConnectionCommand({
      ConnectionId: ctx.connectionId,
      Data: Buffer.from(JSON.stringify(obj) + "\n"),
    })).catch((e) => console.warn("post failed:", e?.name || e));

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { await post({ type: "error", message: "invalid json body" }); return { statusCode: 200 }; }

  if (body.mode === "jockey")    return handleJockeyDirect(body, post);
  if (body.mode === "agentcore") return handleAgentCore(event, body, post);

  await post({ type: "error", message: "set mode to 'agentcore' or 'jockey'" });
  return { statusCode: 200 };
}

// ──────────────── AgentCore Runtime path ────────────────
// Sync handshake (returns immediately so API Gateway's 30s timer doesn't
// fire), then a fire-and-forget self-invoke does the long work and posts
// results back to the same WS connection.
async function handleAgentCore(event, body, post) {
  const ctx = event.requestContext;
  const { knowledge_store_id, prompt, session_id } = body;
  if (!knowledge_store_id || !prompt) {
    await post({ type: "error", message: "missing knowledge_store_id or prompt" });
    return { statusCode: 200 };
  }

  // AgentCore Runtime requires runtimeSessionId to be ≥33 chars.
  const usedSession = (session_id && session_id.length >= 33)
    ? session_id
    : `agentcore-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-padpadpadpad`;

  await post({ type: "session", session_id: usedSession });

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event", // async, returns immediately
      Payload: Buffer.from(JSON.stringify({
        async_task: "agentcore",
        connection_id: ctx.connectionId,
        domain_name:   ctx.domainName,
        stage:         ctx.stage,
        body,
        used_session:  usedSession,
      })),
    }));
  } catch (e) {
    await post({ type: "error", message: `enqueue async: ${errorString(e)}` });
  }
  return { statusCode: 200 };
}

async function handleAgentCoreAsync(event) {
  const { connection_id, domain_name, stage, body, used_session } = event;
  const apigw = new ApiGatewayManagementApiClient({
    endpoint: `https://${domain_name}/${stage}`,
  });
  const post = (obj) =>
    apigw.send(new PostToConnectionCommand({
      ConnectionId: connection_id,
      Data: Buffer.from(JSON.stringify(obj) + "\n"),
    })).catch((e) => console.warn("post failed:", e?.name || e));

  const { knowledge_store_id, prompt, access_token } = body || {};
  const payload = JSON.stringify({
    knowledge_store_id,
    prompt,
    access_token: access_token || null,
  });

  // Heartbeat so the browser knows the run is still alive.
  const heartbeat = setInterval(() => {
    post({ type: "heartbeat", t: Date.now() });
  }, 20_000);

  try {
    let resp;
    try {
      resp = await acc.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn: process.env.AGENTCORE_RUNTIME_ARN,
        runtimeSessionId: used_session,
        payload: new TextEncoder().encode(payload),
      }));
    } catch (e) {
      await post({ type: "error", message: `InvokeAgentRuntime: ${errorString(e)}` });
      await post({ type: "done" });
      return { statusCode: 200 };
    }

    let raw = "";
    try {
      if (resp.response?.transformToString) {
        raw = await resp.response.transformToString();
      } else if (resp.response) {
        for await (const chunk of resp.response) {
          if (chunk?.payload?.transformToString) raw += await chunk.payload.transformToString();
          else if (typeof chunk === "string") raw += chunk;
          else if (chunk instanceof Uint8Array) raw += decoder.decode(chunk);
        }
      }
    } catch (e) {
      await post({ type: "error", message: `read response: ${errorString(e)}` });
      await post({ type: "done" });
      return { statusCode: 200 };
    }

    let answerText = raw;
    try {
      const j = JSON.parse(raw);
      if (typeof j?.text === "string") answerText = j.text;
    } catch { /* not JSON, send as-is */ }

    await post({ type: "text_delta", delta: answerText });
    await post({ type: "done" });
    return { statusCode: 200 };
  } finally {
    clearInterval(heartbeat);
  }
}

// ──────────────── Jockey-direct path (comparison demo) ────────────────
async function handleJockeyDirect(body, post) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const sm = new SecretsManagerClient({});

  const { knowledge_store_id, prompt, instructions, session_id, text_format, include, model } = body;
  if (!knowledge_store_id || !prompt) {
    await post({ type: "error", message: "missing knowledge_store_id or prompt" });
    return { statusCode: 200 };
  }

  let key;
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.TL_API_KEY_SECRET }));
    key = r.SecretString;
  } catch (e) {
    await post({ type: "error", message: `key load failed: ${errorString(e)}` });
    return { statusCode: 200 };
  }

  const tlBase = process.env.TL_BASE_URL || "https://api.twelvelabs.io/v1.3";
  const payload = {
    model: model || "jockey1.0",
    knowledge_store_id,
    input: [{ type: "message", role: "user", content: prompt }],
  };
  if (instructions) payload.instructions = instructions;
  if (session_id)   payload.session_id = session_id;
  if (text_format)  payload.text = { format: text_format };
  if (include)      payload.include = include;

  let r;
  try {
    r = await fetch(`${tlBase}/responses`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    await post({ type: "error", message: `fetch failed: ${errorString(e)}` });
    return { statusCode: 200 };
  }

  const txt = await r.text();
  let json;
  try { json = JSON.parse(txt); }
  catch {
    await post({ type: "error", message: `non-json from TL (${r.status}): ${txt.slice(0, 300)}` });
    return { statusCode: 200 };
  }

  if (!r.ok) {
    await post({ type: "error", message: `TL ${r.status}: ${json?.message || JSON.stringify(json)}` });
    return { statusCode: 200 };
  }

  const chunks = [];
  for (const o of json.output || []) {
    if (o.type !== "message") continue;
    for (const c of o.content || []) {
      if (c.type === "output_text") chunks.push(c.text);
    }
  }

  await post({ type: "session", session_id: json.session_id });
  await post({ type: "result", text: chunks.join("\n"), session_id: json.session_id, usage: json.usage });
  await post({ type: "done" });
  return { statusCode: 200 };
}

function errorString(e) {
  if (!e) return "(no error)";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e?.name || e?.message) return `${e.name || "Error"}: ${e.message || JSON.stringify(e)}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}
