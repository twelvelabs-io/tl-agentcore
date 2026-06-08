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

# Phase 3: Bedrock Titan Multimodal Embeddings index for per-clip representative
# thumbnails. Populated by scripts/ingest_entity_thumbs.py (ffmpeg-extracts
# N frames per asset, Titan-embeds each, upserts here). Queried by the agent's
# find_entity_by_image tool — the AWS-native analog of TL's entity_reid /
# entity_collections retrieval path. Metadata: {asset_id, knowledge_store_id,
# frame_idx, frame_pct, frame_s3_uri}.
resource "aws_s3vectors_index" "entity_thumbs" {
  vector_bucket_name = aws_s3vectors_vector_bucket.clips.vector_bucket_name
  index_name         = "entity-thumbs"
  data_type          = "float32"
  dimension          = 1024 # amazon.titan-embed-image-v1 default output length.
  distance_metric    = "cosine"
}
