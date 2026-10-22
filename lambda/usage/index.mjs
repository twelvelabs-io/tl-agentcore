// usage — surface metering-ledger events for a user and time window.
//
// The runtime writes one row per Bedrock model invocation and per
// in-process tool call to the usage_events DDB table
// (pk=user_id, sk=event_id where event_id = iso_ts + '_' + uuid8, so
// the sk sorts chronologically for free). See agent/tl_agentcore/
// metering/ledger.py for the row shape.
//
// Browser → CloudFront `/usage` → HTTP API Gateway → this lambda.
//
// GET /usage?since=<iso>&until=<iso>&user_id=<sub>&limit=<n>
//   Default window is the last 24h. Default limit is 500 events,
//   capped at 2000 (the per-row size is tiny, so this is just DDB
//   budget hygiene).
//
//   Ownership: non-admin callers only see their own events; the
//   `user_id` query param is admin-only (ADMIN_GROUP_NAME, default
//   "admins"). A non-admin passing user_id is silently coerced to their
//   own sub rather than rejected — the UI query is a GET that may be
//   bookmarked, and the useful behavior is "show me mine" not 403.
//
//   200 {
//     user_id, window: {since, until},
//     summary: {
//       model_invocations, tool_calls,
//       total_input_tokens, total_output_tokens,
//       total_cost_usd,           // null when any invocation had unknown price
//       unknown_cost_count,       // model invocations with price_source=none
//       by_model: {[id]: {invocations, input_tokens, output_tokens, cost_usd}},
//       by_tool:  {[name]: {calls, duration_ms_total}}
//     },
//     events: [...]               // raw rows, newest-first, truncated to limit
//   }
//   401 { error: "missing Authorization: Bearer ..." }
//   500 { error: "..." }
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { authorize } from "./auth.mjs";

const ddb = new DynamoDBClient({});

const USAGE_TABLE = process.env.USAGE_EVENTS_TABLE;
const ADMIN_GROUP = process.env.ADMIN_GROUP_NAME || "admins";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT     = 2000;
const DAY_MS        = 86_400_000;

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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

function toIso(d) {
  return d.toISOString();
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: {}, body: "" };
  }

  const auth = await authorize(event.headers || {});
  if (!auth.ok) return reply(auth.status, { error: auth.message });

  if (!USAGE_TABLE) {
    return reply(500, { error: "USAGE_EVENTS_TABLE env var unset" });
  }

  const qs = event.queryStringParameters || {};
  const now = new Date();
  const since = qs.since || toIso(new Date(now.getTime() - DAY_MS));
  const until = qs.until || toIso(now);
  const limitRaw = parseInt(qs.limit || "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const isAdmin = Array.isArray(auth.identity.groups)
    && auth.identity.groups.includes(ADMIN_GROUP);
  const userId = (isAdmin && qs.user_id) ? qs.user_id : auth.identity.sub;

  // event_id = `${iso_ts}_${uuid8}` — a BETWEEN on event_id with
  // `${since}_` → `${until}_~` captures everything in [since, until)
  // without needing a GSI. `~` is lexicographically higher than hex,
  // so it comfortably bounds the upper range.
  let items;
  try {
    const out = await ddb.send(new QueryCommand({
      TableName: USAGE_TABLE,
      KeyConditionExpression: "user_id = :u AND event_id BETWEEN :s AND :e",
      ExpressionAttributeValues: {
        ":u": { S: userId },
        ":s": { S: `${since}_` },
        ":e": { S: `${until}_~` },
      },
      Limit: limit,
      // Scan backward so the first `limit` rows are the newest in-window.
      ScanIndexForward: false,
    }));
    items = (out.Items || []).map((it) => Object.fromEntries(
      Object.entries(it).map(([k, v]) => [k, fromDdb(v)])
    ));
  } catch (e) {
    return reply(500, { error: "usage query failed", detail: String(e?.message || e) });
  }

  // Build the summary. Totals are per-event; by_model and by_tool roll
  // up by the identity dimension that matters to the viewer.
  const summary = {
    model_invocations: 0,
    tool_calls: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost_usd: 0,
    unknown_cost_count: 0,
    by_model: {},
    by_tool: {},
  };
  let anyUnknownCost = false;

  for (const r of items) {
    if (r.event_type === "model_invoke") {
      summary.model_invocations += 1;
      summary.total_input_tokens += r.input_tokens || 0;
      summary.total_output_tokens += r.output_tokens || 0;
      const modelKey = r.model_id || "unknown";
      const bucket = summary.by_model[modelKey] ||= {
        invocations: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unknown_cost: false,
      };
      bucket.invocations += 1;
      bucket.input_tokens += r.input_tokens || 0;
      bucket.output_tokens += r.output_tokens || 0;
      if (r.cost_usd !== null && r.cost_usd !== undefined) {
        bucket.cost_usd += r.cost_usd;
        summary.total_cost_usd += r.cost_usd;
      } else {
        bucket.unknown_cost = true;
        anyUnknownCost = true;
        summary.unknown_cost_count += 1;
      }
    } else if (r.event_type === "tool_call") {
      summary.tool_calls += 1;
      const toolKey = r.tool_name || "unknown";
      const bucket = summary.by_tool[toolKey] ||= {
        calls: 0, duration_ms_total: 0,
      };
      bucket.calls += 1;
      bucket.duration_ms_total += r.duration_ms || 0;
    }
  }

  // If any model invocation had unknown price, the aggregate cost is a
  // lower bound — surface that as null so the UI shows "—" rather than
  // a false-precise sum.
  if (anyUnknownCost) {
    summary.total_cost_usd = null;
  } else {
    summary.total_cost_usd = Math.round(summary.total_cost_usd * 1e6) / 1e6;
  }

  return reply(200, {
    user_id: userId,
    window: { since, until },
    summary,
    events: items,
  });
};
