# S3 Vectors — Marengo clip embedding store.
#
# One vector bucket and one index per deployment. Vectors carry per-clip
# metadata (asset_id, knowledge_store_id, start_sec, end_sec) so the agent's
# vector_search tool can scope queries to a single KS at retrieval time
# (filter expression on knowledge_store_id).

resource "aws_s3vectors_vector_bucket" "clips" {
  vector_bucket_name = "${local.fqname}-clips"
}

resource "aws_s3vectors_index" "clips" {
  vector_bucket_name = aws_s3vectors_vector_bucket.clips.vector_bucket_name
  index_name         = "clips"
  data_type          = "float32"
  dimension          = 512 # Marengo 3.0 text + video embeddings share this space.
  distance_metric    = "cosine"
}
