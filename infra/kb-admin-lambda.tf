# kb_admin lambda — AWS-native CRUD for knowledge stores + assets.
# Replaces the tl_proxy hop into TwelveLabs SaaS. The demo now stores
# its KS + asset registry entirely in DynamoDB.
#
# Browser → CloudFront `/kb/*` → HTTP API → this lambda → DDB + S3.

locals {
  kb_admin_root = "${path.module}/../lambda/kb_admin"
}

data "archive_file" "kb_admin" {
  type        = "zip"
  source_dir  = local.kb_admin_root
  output_path = "${path.module}/.build/kb_admin.zip"
}

resource "aws_iam_role" "kb_admin" {
  name               = "${local.fqname}-kb-admin"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "kb_admin_basic" {
  role       = aws_iam_role.kb_admin.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "kb_admin_perms" {
  statement {
    sid     = "KsAndAssetsRW"
    actions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
      "dynamodb:Query", "dynamodb:Scan",
    ]
    resources = [
      aws_dynamodb_table.knowledge_stores.arn,
      aws_dynamodb_table.assets.arn,
      "${aws_dynamodb_table.assets.arn}/index/*",
    ]
  }
  statement {
    sid     = "ClipsBucketCleanup"
    actions = ["s3:DeleteObject", "s3:ListBucket"]
    resources = [
      aws_s3_bucket.clips.arn,
      "${aws_s3_bucket.clips.arn}/*",
    ]
  }
  statement {
    sid     = "DeleteRekognitionCollectionOnKsDelete"
    actions = ["rekognition:DeleteCollection"]
    # Per-KS collection_id pattern: <fqname>-ks-<ks_id>
    resources = ["arn:aws:rekognition:${var.region}:${data.aws_caller_identity.current.account_id}:collection/${local.fqname}-ks-*"]
  }
}

resource "aws_iam_role_policy" "kb_admin" {
  role   = aws_iam_role.kb_admin.id
  policy = data.aws_iam_policy_document.kb_admin_perms.json
}

resource "aws_lambda_function" "kb_admin" {
  function_name    = "${local.fqname}-kb-admin"
  role             = aws_iam_role.kb_admin.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.kb_admin.output_path
  source_code_hash = data.archive_file.kb_admin.output_base64sha256
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      KS_TABLE             = aws_dynamodb_table.knowledge_stores.name
      ASSETS_TABLE         = aws_dynamodb_table.assets.name
      KB_CACHE_TABLE       = aws_dynamodb_table.kb_cache.name
      CLIPS_BUCKET         = aws_s3_bucket.clips.bucket
      # CloudFront URL that fronts /hls/* against the clips bucket. Stamped
      # onto every asset row so the player can build manifest URLs without
      # round-tripping to this lambda.
      PLAYBACK_BASE_URL    = "https://${aws_cloudfront_distribution.frontend.domain_name}"
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      STACK_FQNAME         = local.fqname
      ADMIN_GROUP_NAME     = aws_cognito_user_group.admins.name
    }
  }
}

resource "aws_cloudwatch_log_group" "kb_admin" {
  name              = "/aws/lambda/${aws_lambda_function.kb_admin.function_name}"
  retention_in_days = 14
}

# ─── HTTP API routes /kb/* → kb_admin ───────────────────────────────────
resource "aws_apigatewayv2_integration" "kb_admin" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.kb_admin.invoke_arn
  payload_format_version = "2.0"
}

# Glob-route every method under /kb/* to the same lambda; the lambda
# does its own routing on `path` + `method`. Keeps the gateway config
# simple as the surface grows.
locals {
  kb_admin_routes = [
    "GET /kb/knowledge-stores",
    "POST /kb/knowledge-stores",
    "OPTIONS /kb/knowledge-stores",
    "GET /kb/knowledge-stores/{ksId}",
    "DELETE /kb/knowledge-stores/{ksId}",
    "OPTIONS /kb/knowledge-stores/{ksId}",
    "GET /kb/knowledge-stores/{ksId}/items",
    "POST /kb/knowledge-stores/{ksId}/items",
    "OPTIONS /kb/knowledge-stores/{ksId}/items",
    "GET /kb/knowledge-stores/{ksId}/items/{itemId}",
    "DELETE /kb/knowledge-stores/{ksId}/items/{itemId}",
    "OPTIONS /kb/knowledge-stores/{ksId}/items/{itemId}",
    "GET /kb/assets",
    "OPTIONS /kb/assets",
    "GET /kb/assets/{assetId}",
    "DELETE /kb/assets/{assetId}",
    "OPTIONS /kb/assets/{assetId}",
  ]
}

resource "aws_apigatewayv2_route" "kb_admin" {
  for_each  = toset(local.kb_admin_routes)
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.kb_admin.id}"
}

resource "aws_lambda_permission" "http_invoke_kb_admin" {
  statement_id  = "AllowHttpInvokeKbAdmin"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.kb_admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
