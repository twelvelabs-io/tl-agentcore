# S3 bucket + CloudFront distribution for the hosted UI.
#
# Layout:
#   /        → S3 bucket (the built React SPA)
#   /live*   → WebSocket API Gateway (chat lambda); CloudFront passes WSS
#              through transparently. Browser opens wss://<cf>/live?token=…
#              and the WSS upgrade survives the CDN hop.

resource "aws_s3_bucket" "frontend" {
  bucket        = "${local.fqname}-frontend"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.fqname}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${local.fqname} — tl-agentcore demo UI"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  origin {
    domain_name = replace(replace(aws_apigatewayv2_api.ws.api_endpoint, "wss://", ""), "/", "")
    origin_id   = "chat-ws"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # HTTP API Gateway — fronts kb_admin (KS+asset CRUD), kb_graph, presign_upload,
  # embed_clip_start. Legacy origin id `tl-proxy-http` kept for cache-behavior
  # continuity while the rename rolls through; the gateway routes are the same.
  origin {
    domain_name = replace(replace(aws_apigatewayv2_api.http.api_endpoint, "https://", ""), "/", "")
    origin_id   = "tl-proxy-http"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Clips bucket as a CloudFront origin for /hls/* — serves MediaConvert
  # HLS bundles directly from S3 via OAC.
  origin {
    domain_name              = aws_s3_bucket.clips.bucket_regional_domain_name
    origin_id                = "clips-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.clips.id
  }

  default_cache_behavior {
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 60
    max_ttl     = 300
  }

  # /live* → WebSocket API Gateway. AWS managed cache + request policies
  # (AllViewer + Managed-CachingDisabled) for pass-through behavior.
  ordered_cache_behavior {
    path_pattern             = "/live*"
    target_origin_id         = "chat-ws"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # /stitch and /stitch/* → HTTP API Gateway (stitch lambda → MediaConvert).
  # POST /stitch starts a render, GET /stitch/{job_id} polls status.
  # IMPORTANT: do NOT use the glob "/stitch*" here — it ALSO matches
  # "/stitched/..." (preview-MP4 output paths), which routes them to API
  # Gateway and returns {"message":"Not Found"} JSON instead of the actual
  # MP4 from S3. Two specific patterns keep stitch (API) and stitched (S3)
  # cleanly separated regardless of behavior ordering.
  ordered_cache_behavior {
    path_pattern             = "/stitch"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }
  ordered_cache_behavior {
    path_pattern             = "/stitch/*"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # /stitched/* → S3 clips bucket via OAC. Serves MediaConvert preview
  # MP4s assembled by the stitch lambda. Public via CloudFront only;
  # the bucket itself stays private.
  ordered_cache_behavior {
    path_pattern             = "/stitched/*"
    target_origin_id         = "clips-s3"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    min_ttl                  = 0
    default_ttl              = 300
    max_ttl                  = 86400
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  # /kb/* → HTTP API Gateway (kb_admin lambda → DynamoDB).
  # AWS-native CRUD for knowledge stores + assets. Replaces the
  # retired /tl/* path that proxied to api.twelvelabs.io.
  ordered_cache_behavior {
    path_pattern             = "/kb/*"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # /hls/* → S3 clips bucket via OAC. Public-CDN-fronted MediaConvert
  # HLS output; no Cognito on the playback hop (public by random-id
  # obscurity in the asset_id namespace).
  ordered_cache_behavior {
    path_pattern             = "/hls/*"
    target_origin_id         = "clips-s3"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    min_ttl                  = 0
    default_ttl              = 300
    max_ttl                  = 86400
    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  # /upload/* → HTTP API Gateway (presign_upload lambda). Issues short-lived
  # S3 PUT + GET URLs so the browser can stream large media directly to the
  # clips bucket without hitting API Gateway's 10 MB payload cap.
  ordered_cache_behavior {
    path_pattern             = "/upload/*"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # /kb-graph → HTTP API Gateway (kb_graph lambda → kb_cache DDB).
  # Returns the React-Flow-ready {nodes, edges} payload for the Graph tab.
  ordered_cache_behavior {
    path_pattern             = "/kb-graph"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # /settings/* → HTTP API Gateway (settings lambda → kb_cache DDB).
  # View/edit the system prompts the agent + ingest pipeline use.
  ordered_cache_behavior {
    path_pattern             = "/settings/*"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  # /users and /users/* → HTTP API Gateway (users lambda → Cognito).
  # Admin-only user management. Two specific patterns (exact + sub-path)
  # so neither shadows another behavior the way the older /stitch* glob did.
  ordered_cache_behavior {
    path_pattern             = "/users"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }
  ordered_cache_behavior {
    path_pattern             = "/users/*"
    target_origin_id         = "tl-proxy-http"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = false
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewer
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    sid       = "CFReadObjects"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

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

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json
}
