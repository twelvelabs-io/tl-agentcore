# Clips bucket — mirrored video bytes for Bedrock-native ingest and analysis.
#
# Bedrock's TwelveLabs models read media from S3 only (s3Location or
# base64String — no URL input is accepted). This bucket holds one object
# per ingested asset at `clips/<asset_id>.mp4`. Two consumers:
#
#   - ingest_vectors.py runs Marengo 3.0 via Bedrock StartAsyncInvoke
#     against `s3://<this>/clips/<asset_id>.mp4` and writes the resulting
#     clip embeddings to the S3 Vectors index. Async output also lands in
#     this bucket under `embeddings/<invocation_id>/output.json`.
#
#   - The agent runtime's pegasus_analyze tool (Bedrock path, default)
#     resolves an asset_id to `s3://<this>/clips/<asset_id>.mp4` and
#     calls Bedrock Pegasus 1.2 with that s3Location. Runtime role needs
#     s3:GetObject here; granted in iam.tf.

resource "aws_s3_bucket" "clips" {
  bucket = "${local.fqname}-clips"
}

resource "aws_s3_bucket_ownership_controls" "clips" {
  bucket = aws_s3_bucket.clips.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_public_access_block" "clips" {
  bucket                  = aws_s3_bucket.clips.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "clips" {
  bucket = aws_s3_bucket.clips.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Auto-expire the async-invoke output prefix; the embeddings have already
# been copied into the S3 Vectors index by the time ingest finishes.
# uploads/ also auto-expires: TL pulls the bytes during asset creation,
# after which the source object in the uploads/ prefix has no consumer.
# The canonical copy lives at clips/<asset_id>.mp4 once the operator
# mirrors it for Bedrock-side ingestion.
resource "aws_s3_bucket_lifecycle_configuration" "clips" {
  bucket = aws_s3_bucket.clips.id

  rule {
    id     = "expire-embedding-outputs"
    status = "Enabled"
    filter { prefix = "embeddings/" }
    expiration { days = 7 }
  }

  rule {
    id     = "expire-stale-uploads"
    status = "Enabled"
    filter { prefix = "uploads/" }
    expiration { days = 7 }
  }
}

# CORS — browser PUT (presigned URL) needs allow-origin from CloudFront.
resource "aws_s3_bucket_cors_configuration" "clips" {
  bucket = aws_s3_bucket.clips.id

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = [
      "https://${aws_cloudfront_distribution.frontend.domain_name}",
      "http://localhost:5173",
    ]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# ─── CloudFront access to /hls/* on the clips bucket ──────────────────────
# Browser plays MediaConvert HLS bundles directly from S3 through the
# CloudFront /hls/* behavior using an Origin Access Control (no public ACLs;
# bucket stays private). Only objects under hls/ are reachable.
resource "aws_cloudfront_origin_access_control" "clips" {
  name                              = "${local.fqname}-clips-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "clips_bucket_cf" {
  statement {
    sid       = "CFReadHls"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/hls/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
  # Allow the stitch lambda's MediaConvert preview MP4s to be served back.
  statement {
    sid       = "CFReadStitched"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/stitched/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "clips_cf" {
  bucket = aws_s3_bucket.clips.id
  policy = data.aws_iam_policy_document.clips_bucket_cf.json
}
