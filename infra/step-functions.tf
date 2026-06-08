# Phase 3-proper: Step Functions orchestrator for entity-Re-ID ingest.
#
# State machine (asl.json) walks one KS through the full pipeline:
#   ListAssets   → Lambda · enumerate cached asset_ids, build per-asset payloads
#   MapAssets    → Map · concurrency=2 (matches endpoint autoscale cap)
#     InvokeAsync  → Lambda · PutObject input + InvokeEndpointAsync + S3 poll
#     EmbedPatches → Lambda · Titan-embed patches → S3 Vectors entity-patches
#
# Each execution drives the long-lived gdino async endpoint
# (sagemaker-async-endpoint.tf), which scales 0..2 instances based on the
# ApproximateBacklogSizePerInstance metric. First request after scale-up
# eats a ~5-10min TRT-engine cold start; subsequent requests are ~30-60s.

# ─── Package the three Lambdas ────────────────────────────────────────────
data "archive_file" "entity_reid_list_assets" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/entity_reid_list_assets"
  output_path = "${path.module}/.build/entity_reid_list_assets.zip"
  excludes    = ["node_modules", "package-lock.json"]
}

data "archive_file" "entity_reid_invoke_async" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/entity_reid_invoke_async"
  output_path = "${path.module}/.build/entity_reid_invoke_async.zip"
  excludes    = ["node_modules", "package-lock.json"]
}

data "archive_file" "entity_reid_embed_patches" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/entity_reid_embed_patches"
  output_path = "${path.module}/.build/entity_reid_embed_patches.zip"
  excludes    = ["node_modules", "package-lock.json"]
}

# ─── Lambda execution roles ───────────────────────────────────────────────
# Re-uses the shared lambda_assume policy doc from iam.tf.

resource "aws_iam_role" "entity_reid_list_assets" {
  name               = "${local.fqname}-erid-list-assets"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "entity_reid_list_assets_perms" {
  statement {
    sid       = "Cloudwatch"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadKbCache"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.kb_cache.arn]
  }
}

resource "aws_iam_role_policy" "entity_reid_list_assets" {
  role   = aws_iam_role.entity_reid_list_assets.id
  policy = data.aws_iam_policy_document.entity_reid_list_assets_perms.json
}

resource "aws_iam_role" "entity_reid_invoke_async" {
  name               = "${local.fqname}-erid-invoke-async"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "entity_reid_invoke_async_perms" {
  statement {
    sid       = "Cloudwatch"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
  statement {
    sid       = "AsyncIO"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:HeadObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn, "${aws_s3_bucket.clips.arn}/*"]
  }
  statement {
    sid       = "InvokeEndpointAsync"
    actions   = ["sagemaker:InvokeEndpointAsync"]
    resources = [aws_sagemaker_endpoint.gdino.arn]
  }
}

resource "aws_iam_role_policy" "entity_reid_invoke_async" {
  role   = aws_iam_role.entity_reid_invoke_async.id
  policy = data.aws_iam_policy_document.entity_reid_invoke_async_perms.json
}

resource "aws_iam_role" "entity_reid_embed_patches" {
  name               = "${local.fqname}-erid-embed-patches"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "entity_reid_embed_patches_perms" {
  statement {
    sid       = "Cloudwatch"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadAsyncOutputs"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn, "${aws_s3_bucket.clips.arn}/*"]
  }
  statement {
    sid       = "Titan"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:*::foundation-model/*"]
  }
  statement {
    sid     = "WriteEntityPatches"
    actions = ["s3vectors:PutVectors"]
    resources = [
      aws_s3vectors_vector_bucket.clips.vector_bucket_arn,
      "${aws_s3vectors_vector_bucket.clips.vector_bucket_arn}/index/*",
    ]
  }
}

resource "aws_iam_role_policy" "entity_reid_embed_patches" {
  role   = aws_iam_role.entity_reid_embed_patches.id
  policy = data.aws_iam_policy_document.entity_reid_embed_patches_perms.json
}

# ─── Lambda functions ─────────────────────────────────────────────────────
resource "aws_lambda_function" "entity_reid_list_assets" {
  function_name    = "${local.fqname}-erid-list-assets"
  role             = aws_iam_role.entity_reid_list_assets.arn
  filename         = data.archive_file.entity_reid_list_assets.output_path
  source_code_hash = data.archive_file.entity_reid_list_assets.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 60
  memory_size      = 512

  environment {
    variables = {
      KB_CACHE_TABLE    = aws_dynamodb_table.kb_cache.name
      CLIPS_BUCKET_NAME = aws_s3_bucket.clips.bucket
    }
  }
}

resource "aws_lambda_function" "entity_reid_invoke_async" {
  function_name    = "${local.fqname}-erid-invoke-async"
  role             = aws_iam_role.entity_reid_invoke_async.arn
  filename         = data.archive_file.entity_reid_invoke_async.output_path
  source_code_hash = data.archive_file.entity_reid_invoke_async.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  # 14-min ceiling — must cover endpoint cold-start (TRT engine compile
  # ~5-10 min) AND the per-asset inference (~30-60s warm). The poll
  # deadline inside the Lambda is set to 14 min too.
  timeout     = 870
  memory_size = 512

  environment {
    variables = {
      GDINO_ENDPOINT_NAME = aws_sagemaker_endpoint.gdino.name
      POLL_INTERVAL_MS    = "5000"
      POLL_DEADLINE_MS    = "840000"
    }
  }
}

resource "aws_lambda_function" "entity_reid_embed_patches" {
  function_name    = "${local.fqname}-erid-embed-patches"
  role             = aws_iam_role.entity_reid_embed_patches.arn
  filename         = data.archive_file.entity_reid_embed_patches.output_path
  source_code_hash = data.archive_file.entity_reid_embed_patches.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  timeout          = 300
  memory_size      = 1024

  environment {
    variables = {
      VECTOR_BUCKET_NAME          = aws_s3vectors_vector_bucket.clips.vector_bucket_name
      VECTOR_INDEX_ENTITY_PATCHES = aws_s3vectors_index.entity_patches.index_name
      TITAN_IMAGE_EMBED_MODEL_ID  = "amazon.titan-embed-image-v1"
    }
  }
}

# ─── State Machine execution role ─────────────────────────────────────────
data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "entity_reid_sfn" {
  name               = "${local.fqname}-erid-sfn"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "entity_reid_sfn_perms" {
  statement {
    sid     = "InvokeLambdas"
    actions = ["lambda:InvokeFunction"]
    resources = [
      aws_lambda_function.entity_reid_list_assets.arn,
      aws_lambda_function.entity_reid_invoke_async.arn,
      aws_lambda_function.entity_reid_embed_patches.arn,
    ]
  }
}

resource "aws_iam_role_policy" "entity_reid_sfn" {
  role   = aws_iam_role.entity_reid_sfn.id
  policy = data.aws_iam_policy_document.entity_reid_sfn_perms.json
}

# ─── State machine ────────────────────────────────────────────────────────
# Image tag drives the Model + EndpointConfig in sagemaker-async-endpoint.tf;
# the state machine references the endpoint by name (resolved at apply time).
variable "gdino_image_tag" {
  type        = string
  default     = "latest"
  description = "Image tag in the gdino ECR repo. Bumping forces a new Model + EndpointConfig + Endpoint update."
}

locals {
  entity_reid_definition = replace(
    replace(
      replace(
        file("${path.module}/step-functions/entity_reid.asl.json"),
        "$${LIST_ASSETS_FN_ARN}",
        aws_lambda_function.entity_reid_list_assets.arn,
      ),
      "$${INVOKE_ASYNC_FN_ARN}",
      aws_lambda_function.entity_reid_invoke_async.arn,
    ),
    "$${EMBED_PATCHES_FN_ARN}",
    aws_lambda_function.entity_reid_embed_patches.arn,
  )
}

resource "aws_sfn_state_machine" "entity_reid" {
  name       = "${local.fqname}-entity-reid"
  role_arn   = aws_iam_role.entity_reid_sfn.arn
  definition = local.entity_reid_definition

  type = "STANDARD"
}
