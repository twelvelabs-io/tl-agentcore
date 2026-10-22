// scores — surface online judge rows for one agent turn to the SPA.
//
// The runtime dispatches the coherence + reference-validity judges
// fire-and-forget at end-of-turn (see agent/tl_agentcore/scoring/
// judge_runner.py). Rows land in the scores DDB table:
//
//   pk = response_id   sk = judge_name  (coherence | reference_validity)
//   payload: score (1-5|null), justification, latency_ms, sampled_at,
//            user_id, knowledge_store_id, error?, missing_asset_ids?
//
// 90-day TTL via `expires_at`.
//
// Browser → CloudFront `/scores/{response_id}` → HTTP API Gateway → this lambda.
//
// GET /scores/{response_id}
//   200 { response_id, judges: [{judge_name, score?, justification?,
//                                 latency_ms?, sampled_at?, error?,
//                                 missing_asset_ids?}] }
//        — `judges` is [] when no rows have landed yet (judges may be
//          delayed a few seconds after response.completed since they
//          run fire-and-forget).
//   400 { error: "response_id path param required" }
//   401 { error: "missing Authorization: Bearer ..." }
//   403 { error: "not allowed to read this response's scores" }
//   500 { error: "..." }
//
// Ownership: the judge row carries user_id (the Cognito sub of whoever
// ran that turn). The lambda filters to rows matching the caller's
// `sub`, so one producer can't read another producer's judge trace by
// guessing a response_id. Admins (ADMIN_GROUP_NAME) see all rows.

import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { authorize } from "./auth.mjs";

const ddb = new DynamoDBClient({});

const SCORES_TABLE = process.env.SCORES_TABLE;
const ADMIN_GROUP  = process.env.ADMIN_GROUP_NAME || "admins";

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// Flatten DDB AttributeValue → plain JS. Mirrors the helper in kb_graph
// but kept inline so the two lambdas stay independently deployable.
function fromDdb(v) {
  if (v == null) return null;
  if ("S"    in v) return v.S;
  if ("N"    in v) return v.N.includes(".") ? parseFloat(v.N) : parseInt(v.N, 10);
  if ("BOOL" in v) return v.BOOL;
  if ("NULL" in v) return null;
  if ("L"    in v) return v.L.map(fromDdb);
  if ("M"    in v) return Object.fromEntries(Object.entries(v.M).map(([k, x]) => [k, fromDdb(x)]));
  if ("SS"   in v) return v.SS;
  if ("NS"   in v) return v.NS.map((n) => (n.includes(".") ? parseFloat(n) : parseInt(n, 10)));
  return null;
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {}, body: "" };
  }

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });

  const responseId = event.pathParameters?.response_id
    || event.pathParameters?.responseId;
  if (!responseId) {
    return reply(400, { error: "response_id path param required" });
  }

  if (!SCORES_TABLE) {
    return reply(500, { error: "SCORES_TABLE env var unset" });
  }

  let items;
  try {
    const out = await ddb.send(new QueryCommand({
      TableName: SCORES_TABLE,
      KeyConditionExpression: "response_id = :r",
      ExpressionAttributeValues: { ":r": { S: responseId } },
      // Judges land in 1-2 rows per turn (coherence + reference_validity);
      // a hard cap keeps the response small even if ops adds more judges.
      Limit: 20,
    }));
    items = (out.Items || []).map((it) => Object.fromEntries(
      Object.entries(it).map(([k, v]) => [k, fromDdb(v)])
    ));
  } catch (e) {
    return reply(500, { error: "scores query failed", detail: String(e?.message || e) });
  }

  const isAdmin = Array.isArray(auth.identity.groups)
    && auth.identity.groups.includes(ADMIN_GROUP);

  // Ownership gate. If any row has a user_id and it doesn't match the
  // caller's sub, this response belongs to another user — refuse the
  // whole payload rather than silently filter, so the caller sees the
  // 403 rather than a confusing empty result. An empty table (no judges
  // yet) returns 200 with judges=[].
  if (!isAdmin && items.length > 0) {
    const owners = new Set(items.map((r) => r.user_id).filter(Boolean));
    if (owners.size > 0 && !owners.has(auth.identity.sub)) {
      return reply(403, { error: "not allowed to read this response's scores" });
    }
  }

  // Project just the fields the UI renders. Keeps user_id /
  // knowledge_store_id out of the response — the caller already knows
  // their own id, and the ks is on the agent turn itself.
  const judges = items.map((r) => {
    const row = {
      judge_name: r.judge_name,
    };
    if (r.score !== undefined && r.score !== null) row.score = r.score;
    if (r.justification) row.justification = r.justification;
    if (r.latency_ms !== undefined && r.latency_ms !== null) row.latency_ms = r.latency_ms;
    if (r.sampled_at) row.sampled_at = r.sampled_at;
    if (r.error) row.error = r.error;
    if (r.missing_asset_ids) row.missing_asset_ids = r.missing_asset_ids;
    return row;
  });

  return reply(200, { response_id: responseId, judges });
};
