# presign_upload lambda — issues short-lived S3 PUT + GET presigned URLs
# so the browser can upload media bytes directly to the clips bucket
# (bypassing the 10 MB HTTP API payload cap), and TwelveLabs can ingest
# from the GET URL on its end.
#
# Browser → CloudFront `/upload/presign` → HTTP API → this lambda → S3 presign

locals {
  presign_upload_root = "${path.module}/../lambda/presign_upload"
}

data "archive_file" "presign_upload" {
  type        = "zip"
  source_dir  = local.presign_upload_root
  output_path = "${path.module}/.build/presign_upload.zip"
}

resource "aws_iam_role" "presign_upload" {
  name               = "${local.fqname}-presign-upload"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "presign_upload_basic" {
  role       = aws_iam_role.presign_upload.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "presign_upload_perms" {
  # Sign PUT and GET requests against the uploads/ prefix on the clips bucket.
  statement {
    sid     = "S3PresignUploads"
    actions = ["s3:PutObject", "s3:GetObject"]
    resources = [
      "${aws_s3_bucket.clips.arn}/uploads/*",
    ]
  }
}

resource "aws_iam_role_policy" "presign_upload" {
  role   = aws_iam_role.presign_upload.id
  policy = data.aws_iam_policy_document.presign_upload_perms.json
}

resource "aws_lambda_function" "presign_upload" {
  function_name    = "${local.fqname}-presign-upload"
  role             = aws_iam_role.presign_upload.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.presign_upload.output_path
  source_code_hash = data.archive_file.presign_upload.output_base64sha256
  timeout          = 10
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CLIPS_BUCKET_NAME    = aws_s3_bucket.clips.bucket
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
    }
  }
}

resource "aws_cloudwatch_log_group" "presign_upload" {
  name              = "/aws/lambda/${aws_lambda_function.presign_upload.function_name}"
  retention_in_days = 14
}

# Wire the lambda into the HTTP API.
resource "aws_apigatewayv2_integration" "presign_upload" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.presign_upload.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "presign_upload_post" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /upload/presign"
  target    = "integrations/${aws_apigatewayv2_integration.presign_upload.id}"
}

resource "aws_lambda_permission" "http_invoke_presign_upload" {
  statement_id  = "AllowHttpInvokePresignUpload"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.presign_upload.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}

# ── embed_clip_start ───────────────────────────────────────────────────
# After the browser attaches a freshly-uploaded asset to a KB, it calls
# POST /upload/embed. This lambda copies the file from uploads/ to
# clips/<asset_id>.mp4 and kicks off Bedrock Marengo async invoke. The
# output path encodes asset_id + ks_id so the finalize step can rehydrate
# them from the S3 event.

locals {
  embed_clip_start_root    = "${path.module}/../lambda/embed_clip_start"
  embed_clip_finalize_root = "${path.module}/../lambda/embed_clip_finalize"
}

data "archive_file" "embed_clip_start" {
  type        = "zip"
  source_dir  = local.embed_clip_start_root
  output_path = "${path.module}/.build/embed_clip_start.zip"
}

resource "aws_iam_role" "embed_clip_start" {
  name               = "${local.fqname}-embed-start"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "embed_clip_start_basic" {
  role       = aws_iam_role.embed_clip_start.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "embed_clip_start_perms" {
  # Copy uploads/<...> → clips/<asset_id>.mp4 within the same bucket.
  statement {
    sid     = "CopyClips"
    actions = ["s3:GetObject", "s3:PutObject", "s3:GetObjectTagging", "s3:PutObjectTagging"]
    resources = [
      "${aws_s3_bucket.clips.arn}/uploads/*",
      "${aws_s3_bucket.clips.arn}/clips/*",
    ]
  }
  # HeadObject for the post-copy verification.
  statement {
    sid       = "HeadClips"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/clips/*"]
  }
  # Bedrock async invoke against Marengo. StartAsyncInvoke requires
  # `bedrock:InvokeModel` on BOTH the foundation-model ARN (identifies
  # the model) AND the account-scoped async-invoke resource ARN
  # (identifies the queued job). Missing the async-invoke resource is
  # what caused the embed lambda to return 500 with an
  # AccessDeniedException from Bedrock — same bug we hit on the
  # runtime IAM policy in v0.4.5.
  statement {
    sid     = "BedrockAsync"
    actions = ["bedrock:StartAsyncInvoke", "bedrock:GetAsyncInvoke", "bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:async-invoke/*",
    ]
  }
  # The async invoke writes output.json into our clips bucket.
  statement {
    sid       = "WriteEmbeddingsOutput"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.clips.arn}/embeddings/auto/*"]
  }
  # Write the canonical assets row at upload time. The UI lists pending
  # rows immediately; hls_finalize / Marengo finalize flip the status
  # fields later.
  statement {
    sid       = "WriteAssetsRow"
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.assets.arn]
  }
  # MediaConvert: endpoint discovery + job creation + pass the service role.
  statement {
    sid       = "MediaConvertJob"
    actions   = ["mediaconvert:DescribeEndpoints", "mediaconvert:CreateJob", "mediaconvert:GetJob"]
    resources = ["*"]
  }
  statement {
    sid       = "PassMediaConvertRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.mediaconvert.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["mediaconvert.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "embed_clip_start" {
  role   = aws_iam_role.embed_clip_start.id
  policy = data.aws_iam_policy_document.embed_clip_start_perms.json
}

resource "aws_lambda_function" "embed_clip_start" {
  function_name    = "${local.fqname}-embed-start"
  role             = aws_iam_role.embed_clip_start.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.embed_clip_start.output_path
  source_code_hash = data.archive_file.embed_clip_start.output_base64sha256
  timeout          = 30
  memory_size      = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CLIPS_BUCKET_NAME        = aws_s3_bucket.clips.bucket
      AWS_ACCOUNT_ID           = data.aws_caller_identity.current.account_id
      MARENGO_BEDROCK_MODEL_ID = "twelvelabs.marengo-embed-3-0-v1:0"
      ASSETS_TABLE             = aws_dynamodb_table.assets.name
      MEDIACONVERT_ROLE_ARN    = aws_iam_role.mediaconvert.arn
      PLAYBACK_BASE_URL        = "https://${aws_cloudfront_distribution.frontend.domain_name}"
      COGNITO_USER_POOL_ID     = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID        = aws_cognito_user_pool_client.spa.id
    }
  }
}

resource "aws_cloudwatch_log_group" "embed_clip_start" {
  name              = "/aws/lambda/${aws_lambda_function.embed_clip_start.function_name}"
  retention_in_days = 14
}

resource "aws_apigatewayv2_integration" "embed_clip_start" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.embed_clip_start.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "embed_clip_start_post" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /upload/embed"
  target    = "integrations/${aws_apigatewayv2_integration.embed_clip_start.id}"
}

resource "aws_lambda_permission" "http_invoke_embed_clip_start" {
  statement_id  = "AllowHttpInvokeEmbedClipStart"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.embed_clip_start.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}

# ── embed_clip_finalize ────────────────────────────────────────────────
# Triggered by S3 ObjectCreated on
# `embeddings/auto/<asset_id>/<ks_id>/<invocation_id>/output.json`. Reads
# the Bedrock async-invoke output, keeps clip-scope segments, and writes
# vectors into the S3 Vectors index with full metadata.

data "archive_file" "embed_clip_finalize" {
  type        = "zip"
  source_dir  = local.embed_clip_finalize_root
  output_path = "${path.module}/.build/embed_clip_finalize.zip"
}

resource "aws_iam_role" "embed_clip_finalize" {
  name               = "${local.fqname}-embed-finalize"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "embed_clip_finalize_basic" {
  role       = aws_iam_role.embed_clip_finalize.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "embed_clip_finalize_perms" {
  statement {
    sid       = "ReadOutput"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/embeddings/auto/*"]
  }
  statement {
    sid = "WriteVectors"
    actions = [
      "s3vectors:PutVectors",
      "s3vectors:GetVectors",
    ]
    resources = [
      aws_s3vectors_vector_bucket.clips.vector_bucket_arn,
      "${aws_s3vectors_vector_bucket.clips.vector_bucket_arn}/index/*",
    ]
  }
}

resource "aws_iam_role_policy" "embed_clip_finalize" {
  role   = aws_iam_role.embed_clip_finalize.id
  policy = data.aws_iam_policy_document.embed_clip_finalize_perms.json
}

resource "aws_lambda_function" "embed_clip_finalize" {
  function_name    = "${local.fqname}-embed-finalize"
  role             = aws_iam_role.embed_clip_finalize.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.embed_clip_finalize.output_path
  source_code_hash = data.archive_file.embed_clip_finalize.output_base64sha256
  timeout          = 120
  memory_size      = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CLIPS_BUCKET_NAME  = aws_s3_bucket.clips.bucket
      VECTOR_BUCKET_NAME = aws_s3vectors_vector_bucket.clips.vector_bucket_name
      VECTOR_INDEX_NAME  = aws_s3vectors_index.clips.index_name
    }
  }
}

resource "aws_cloudwatch_log_group" "embed_clip_finalize" {
  name              = "/aws/lambda/${aws_lambda_function.embed_clip_finalize.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "s3_invoke_embed_clip_finalize" {
  statement_id  = "AllowS3InvokeEmbedClipFinalize"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.embed_clip_finalize.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.clips.arn
}

resource "aws_s3_bucket_notification" "clips_triggers" {
  bucket = aws_s3_bucket.clips.id

  lambda_function {
    id                  = "marengo-finalize"
    lambda_function_arn = aws_lambda_function.embed_clip_finalize.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "embeddings/auto/"
    filter_suffix       = "output.json"
  }

  lambda_function {
    id                  = "hls-finalize"
    lambda_function_arn = aws_lambda_function.hls_finalize.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "hls/"
    filter_suffix       = "_master.m3u8"
  }

  # asset_profile runs Pegasus per-clip — wired here so any new
  # clips/<asset_id>.mp4 (uploaded via UI or copied during seeding)
  # gets a kb_cache ASSET# row written automatically.
  lambda_function {
    id                  = "asset-profile"
    lambda_function_arn = aws_lambda_function.asset_profile.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "clips/"
    filter_suffix       = ".mp4"
  }

  depends_on = [
    aws_lambda_permission.s3_invoke_embed_clip_finalize,
    aws_lambda_permission.s3_invoke_hls_finalize,
    aws_lambda_permission.s3_invoke_asset_profile,
  ]
}
