# profile_cache — pre-computed per-knowledge-store profile + per-asset summaries.
# Without this, the agent re-derives context (Pegasus/Marengo calls) every
# turn; with it, the agent reads cached digests in single-digit milliseconds
# and only falls through to the public TL API for fine-grained work.
#
# Two item shapes share the table:
#   pk = "ks#<knowledge_store_id>"  sk = "OVERVIEW"        → corpus digest
#   pk = "ks#<knowledge_store_id>"  sk = "ASSET#<asset_id>" → per-asset profile
#
# Single-table layout keeps the Query for "list all assets in this KS"
# trivial: pk = ks#... and sk begins_with ASSET#.

resource "aws_dynamodb_table" "profile_cache" {
  name         = "${local.fqname}-profile-cache"
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
