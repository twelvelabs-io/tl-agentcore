# Centralized log bucket + versioning + access-logging for the
# frontend + clips buckets. Keeps CKV_AWS_18 / CKV_AWS_21 / CKV_AWS_86
# / CKV_AWS_76 satisfied without spraying config across every bucket
# file.

resource "aws_s3_bucket" "logs" {
  bucket        = "${local.fqname}-logs"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    # BucketOwnerPreferred + ACLs enabled — CloudFront still needs
    # bucket ACLs to write standard-logging objects. S3 server
    # access logs also target this bucket, so leave ACLs on.
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "logs" {
  depends_on = [aws_s3_bucket_ownership_controls.logs]
  bucket     = aws_s3_bucket.logs.id
  # CloudFront's standard logging writes as awslogsdelivery; without
  # log-delivery-write the writes 403.
  acl = "log-delivery-write"
}

# 90-day rolling window so logs don't grow forever. Aborted multipart
# uploads on the log bucket itself get cleaned up after a day.
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

# ─── Versioning + access logging on the two data buckets ──────────────────

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_logging" "frontend" {
  bucket        = aws_s3_bucket.frontend.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-frontend/"
}

resource "aws_s3_bucket_versioning" "clips" {
  bucket = aws_s3_bucket.clips.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_logging" "clips" {
  bucket        = aws_s3_bucket.clips.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-clips/"
}
