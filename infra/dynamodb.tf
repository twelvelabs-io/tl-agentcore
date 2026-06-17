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
  range_key    = "sk"

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

  attribute {
    name = "asset_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "audiences" {
  name         = "${local.fqname}-audiences"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "segment_id"

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
