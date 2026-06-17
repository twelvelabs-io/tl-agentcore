// chat lambda — WebSocket handler for the tl-agentcore demo UI.
//
// The only flow this lambda handles is mode === "agentcore", which invokes
// the AgentCore Runtime (Strands agent container). The actual work runs in
// an async self-invoke because runs can take 60-300s and API Gateway WS
// has a hard 30s integration cap.
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

  if (body.mode === "agentcore") return handleAgentCore(event, body, post);

  await post({ type: "error", message: "set mode to 'agentcore'" });
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

    // The Runtime now streams Server-Sent Events. Each frame is
    // `data: {json}\n\n`. We parse incrementally and forward each
    // event to the WS connection as it arrives — that's how the UI
    // sees per-tool events (tool_call, tool_result) live, instead of
    // waiting for the full agent run to finish.
    let buffer = "";
    const flush = async () => {
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = frame
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        const json = dataLines.join("");
        let evt;
        try { evt = JSON.parse(json); } catch { continue; }
        await post(evt);
      }
    };

    try {
      if (resp.response?.transformToString) {
        buffer += await resp.response.transformToString();
        await flush();
      } else if (resp.response) {
        for await (const chunk of resp.response) {
          if (chunk?.payload?.transformToString) buffer += await chunk.payload.transformToString();
          else if (typeof chunk === "string") buffer += chunk;
          else if (chunk instanceof Uint8Array) buffer += decoder.decode(chunk);
          await flush();
        }
      }
      // Drain anything left without a trailing \n\n (some SDK chunkings
      // emit the final frame without a separator).
      if (buffer.trim()) {
        buffer += "\n\n";
        await flush();
      }
    } catch (e) {
      await post({ type: "error", message: `read response: ${errorString(e)}` });
      await post({ type: "done" });
      return { statusCode: 200 };
    }

    await post({ type: "done" });
    return { statusCode: 200 };
  } finally {
    clearInterval(heartbeat);
  }
}

function errorString(e) {
  if (!e) return "(no error)";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e?.name || e?.message) return `${e.name || "Error"}: ${e.message || JSON.stringify(e)}`;
  try { return JSON.stringify(e); } catch { return String(e); }
}
