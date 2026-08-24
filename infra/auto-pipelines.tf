# Auto-pipelines: the two lambdas that complete the "drop a file, walk
# away, everything works" promise.
#
#   asset_profile  — S3-triggered per upload. Runs Bedrock Pegasus 1.2 on
#                    clips/<asset_id>.mp4 and writes ASSET#<asset_id> into
#                    kb_cache. Replaces the manual `ingest_kb_cache.py`
#                    run for per-asset profiles.
#
#   ks_rollup      — EventBridge-scheduled every 4 hours. For each KS,
#                    aggregates ASSET# rows into the cross-asset ENTITY#,
#                    OVERVIEW and EVENT# rows. Replaces the manual
#                    `build_event_groups.py` and the aggregation pass in
#                    `ingest_kb_cache.py`.
#
# Both share the lambda_assume policy doc defined in iam.tf.

# ─── asset_profile ─────────────────────────────────────────────────────────
locals {
  asset_profile_root = "${path.module}/../lambda/asset_profile"
}

data "archive_file" "asset_profile" {
  type        = "zip"
  source_dir  = local.asset_profile_root
  output_path = "${path.module}/.build/asset_profile.zip"
}

resource "aws_iam_role" "asset_profile" {
  name               = "${local.fqname}-asset-profile"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "asset_profile_basic" {
  role       = aws_iam_role.asset_profile.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "asset_profile_perms" {
  statement {
    sid       = "ReadAssetsRow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.assets.arn]
  }
  statement {
    sid       = "WriteCache"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.kb_cache.arn]
  }
  statement {
    sid       = "PegasusBedrock"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*"]
  }
  statement {
    sid       = "ReadClipMp4"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/clips/*"]
  }
  # Async-invoke ks_rollup on the KS this asset belongs to, so OVERVIEW /
  # ENTITY# / EVENT# rows refresh within seconds of the last asset in the
  # KS finishing its profile — no 4-hour cache-miss window.
  statement {
    sid       = "InvokeKsRollup"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.ks_rollup.arn]
  }
}

resource "aws_iam_role_policy" "asset_profile" {
  role   = aws_iam_role.asset_profile.id
  policy = data.aws_iam_policy_document.asset_profile_perms.json
}

resource "aws_lambda_function" "asset_profile" {
  function_name    = "${local.fqname}-asset-profile"
  role             = aws_iam_role.asset_profile.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.asset_profile.output_path
  source_code_hash = data.archive_file.asset_profile.output_base64sha256
  # Pegasus 1.2 on Bedrock takes 30–90 s per asset; give it room.
  timeout     = 300
  memory_size = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CLIPS_BUCKET       = aws_s3_bucket.clips.bucket
      CLIPS_BUCKET_OWNER = data.aws_caller_identity.current.account_id
      ASSETS_TABLE       = aws_dynamodb_table.assets.name
      KB_CACHE_TABLE     = aws_dynamodb_table.kb_cache.name
      PEGASUS_MODEL_ID   = var.pegasus_bedrock_model_id
      KS_ROLLUP_LAMBDA   = aws_lambda_function.ks_rollup.function_name
    }
  }
}

resource "aws_cloudwatch_log_group" "asset_profile" {
  name              = "/aws/lambda/${aws_lambda_function.asset_profile.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "s3_invoke_asset_profile" {
  statement_id  = "AllowS3InvokeAssetProfile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.asset_profile.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.clips.arn
}

# ─── ks_rollup ─────────────────────────────────────────────────────────────
locals {
  ks_rollup_root = "${path.module}/../lambda/ks_rollup"
}

data "archive_file" "ks_rollup" {
  type        = "zip"
  source_dir  = local.ks_rollup_root
  output_path = "${path.module}/.build/ks_rollup.zip"
}

resource "aws_iam_role" "ks_rollup" {
  name               = "${local.fqname}-ks-rollup"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ks_rollup_basic" {
  role       = aws_iam_role.ks_rollup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "ks_rollup_perms" {
  statement {
    sid       = "ScanKs"
    actions   = ["dynamodb:Scan"]
    resources = [aws_dynamodb_table.knowledge_stores.arn]
  }
  statement {
    sid       = "QueryWriteCache"
    actions   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:BatchWriteItem"]
    resources = [aws_dynamodb_table.kb_cache.arn]
  }
  # Celebrity rollup reads from the assets table (where index_faces writes
  # celebrities[]) via the by-ks GSI.
  statement {
    sid       = "QueryAssetsForCelebrities"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.assets.arn, "${aws_dynamodb_table.assets.arn}/index/*"]
  }
  statement {
    sid       = "ClaudeBedrock"
    actions   = ["bedrock:InvokeModel"]
    resources = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*"]
  }
}

resource "aws_iam_role_policy" "ks_rollup" {
  role   = aws_iam_role.ks_rollup.id
  policy = data.aws_iam_policy_document.ks_rollup_perms.json
}

resource "aws_lambda_function" "ks_rollup" {
  function_name    = "${local.fqname}-ks-rollup"
  role             = aws_iam_role.ks_rollup.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.ks_rollup.output_path
  source_code_hash = data.archive_file.ks_rollup.output_base64sha256
  # Per-KS rollup is cheap when there are few asset profiles, slow when
  # there are many; 5 minutes covers a KS up to ~1,500 assets.
  timeout     = 600
  memory_size = 1024

  tracing_config { mode = "Active" }

  environment {
    variables = {
      KS_TABLE        = aws_dynamodb_table.knowledge_stores.name
      KB_CACHE_TABLE  = aws_dynamodb_table.kb_cache.name
      ASSETS_TABLE    = aws_dynamodb_table.assets.name
      CLAUDE_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
    }
  }
}

resource "aws_cloudwatch_log_group" "ks_rollup" {
  name              = "/aws/lambda/${aws_lambda_function.ks_rollup.function_name}"
  retention_in_days = 14
}

# EventBridge schedule — every 4 hours.
resource "aws_cloudwatch_event_rule" "ks_rollup_schedule" {
  name                = "${local.fqname}-ks-rollup"
  description         = "Periodically aggregate ASSET# rows into ENTITY#, OVERVIEW, EVENT# per KS."
  schedule_expression = "rate(4 hours)"
}

resource "aws_cloudwatch_event_target" "ks_rollup_schedule" {
  rule = aws_cloudwatch_event_rule.ks_rollup_schedule.name
  arn  = aws_lambda_function.ks_rollup.arn
}

resource "aws_lambda_permission" "events_invoke_ks_rollup" {
  statement_id  = "AllowEventsInvokeKsRollup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ks_rollup.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ks_rollup_schedule.arn
}
