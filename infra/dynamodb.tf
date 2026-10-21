# DynamoDB tables backing the agent's tool surface.
#
# Three tables back the cache + domain-lookup tools in agent/tl_agentcore/agent.py:
#
#   kb_cache   — Pre-computed per-knowledge-store profile + per-asset summaries.
#                Holds the mini-ontology / content-profile layer.
#                Populated by scripts/ingest-kb-cache.py.
#
#                pk = "ks#<knowledge_store_id>"  sk = "OVERVIEW"
#                  → asset_count, top_moods[], top_styles[], top_roles[],
#                    sample_titles[], marengo_index_id, marengo_video_count
#                pk = "ks#<knowledge_store_id>"  sk = "ASSET#<asset_id>"
#                  → title, one_liner, mood_tags[], primary_subjects[],
#                    visual_style, role_hint, ingested_at
#
#                Single-table layout keeps "list all assets in this KS" as a
#                single Query: pk = ks#... AND begins_with(sk, ASSET#).
#
#   rights     — Licensing windows + talent clearances per asset_id.
#                Keyed by asset_id. Seeded by scripts/seed-rights.py for the
#                demo; production deployments wire to existing rights systems.
#
#   audiences  — Audience-intelligence segments (genre affinity, daypart
#                preferences, demographics). Keyed by segment_id. Seeded by
#                scripts/seed-audiences.py.

resource "aws_dynamodb_table" "kb_cache" {
  name         = "${local.fqname}-kb-cache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  point_in_time_recovery {
    enabled = true
  }
  range_key = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
}

resource "aws_dynamodb_table" "rights" {
  name         = "${local.fqname}-rights"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "asset_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "asset_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "audiences" {
  name         = "${local.fqname}-audiences"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "segment_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "segment_id"
    type = "S"
  }
}

# ─── AWS-native KS + asset registry ──────────────────────────────────────
# These two tables replace the TwelveLabs-side knowledge-stores + assets
# endpoints. Nothing in the demo talks to api.twelvelabs.io any more — the
# operator's knowledge stores live entirely in this account.

resource "aws_dynamodb_table" "knowledge_stores" {
  name         = "${local.fqname}-knowledge-stores"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "ks_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "ks_id"
    type = "S"
  }
}

# One row per uploaded asset. Items live alongside the KS row as
# (knowledge_store_id, asset_id) — the GSI lets the UI list every asset
# in a KS without scanning the table.
resource "aws_dynamodb_table" "assets" {
  name         = "${local.fqname}-assets"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "asset_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "asset_id"
    type = "S"
  }
  attribute {
    name = "knowledge_store_id"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "by-ks"
    hash_key        = "knowledge_store_id"
    range_key       = "created_at"
    projection_type = "ALL"
  }
}

# ─── Multi-turn session state + long-term user memory ────────────────────
#
# PR #4 of the Jockey-parity roadmap. Two new tables:
#
#   sessions  — Per-AgentCore-session scratch for resuming context across
#               turns. One row per AgentCore runtime session_id (the ≥33-char
#               id the browser carries in X-Amzn-Bedrock-AgentCore-Runtime-
#               Session-Id). The runtime writes an updated row at the end of
#               every turn with the final <plan>...</plan> text, the prompt,
#               and the knowledge_store_id. 7-day TTL via `expires_at`.
#
#               Read-for-resume (previous_response_id semantics) is NOT
#               wired in this PR — the UI continues to echo [CURRENT PLAN]
#               back on follow-up turns. The write-only path lands first so
#               that multi-device resume + audit become possible without a
#               wire-format change (deferred until after PR #15 merges).
#
#   memories  — Long-term, per-user, agent-callable notes and named clip
#               references (TRefs). Agent tools `manage_memory` and
#               `save_tref_to_memory` are the only writers; user_id is the
#               Cognito `sub` claim decoded from the access_token the
#               browser passes on the WS handshake. Durable, no TTL —
#               explicit delete via `manage_memory(action="delete", ...)`.

resource "aws_dynamodb_table" "sessions" {
  name         = "${local.fqname}-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "session_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

resource "aws_dynamodb_table" "memories" {
  name         = "${local.fqname}-memories"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  range_key    = "memory_id"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "user_id"
    type = "S"
  }
  attribute {
    name = "memory_id"
    type = "S"
  }
}

# ─── Mining plans (PR #10 of Jockey parity) ──────────────────────────────
#
#   jockey_plans — Saved agent prompts that run on an EventBridge schedule.
#                  PK=plan_id (24-hex uuid4). GSI `by-ks` lets `jockey_list`
#                  filter by knowledge_store_id without a Scan. One row holds
#                  `prompt`, `schedule_expression` (EventBridge format), the
#                  `schedule_arn` the agent created, and `enabled` for pause.
#                  Scoped by KS, not by user_id (user-id ownership adds in a
#                  follow-up when PR #16 lands and ships the user_id ContextVar).
#
#   jockey_runs  — Append-only history of plan executions. PK=plan_id, SK=run_id
#                  (ISO-prefixed ULID so range queries sort newest-last). 30-day
#                  TTL via `expires_at` keeps the table small; status + result_text
#                  + error are populated by the mining-run Lambda.

resource "aws_dynamodb_table" "jockey_plans" {
  name         = "${local.fqname}-jockey-plans"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "plan_id"

  point_in_time_recovery { enabled = true }

  attribute {
    name = "plan_id"
    type = "S"
  }
  attribute {
    name = "knowledge_store_id"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "by-ks"
    hash_key        = "knowledge_store_id"
    range_key       = "created_at"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "jockey_runs" {
  name         = "${local.fqname}-jockey-runs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "plan_id"
  range_key    = "run_id"

  point_in_time_recovery { enabled = true }

  attribute {
    name = "plan_id"
    type = "S"
  }
  attribute {
    name = "run_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}
