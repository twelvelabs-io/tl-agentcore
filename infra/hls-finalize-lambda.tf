# hls_finalize lambda — S3-triggered on hls/<asset_id>/master_master.m3u8 land.
# Flips the matching assets row hls_status + status from "pending" → "ready"
# so the UI can play it.

locals {
  hls_finalize_root = "${path.module}/../lambda/hls_finalize"
}

data "archive_file" "hls_finalize" {
  type        = "zip"
  source_dir  = local.hls_finalize_root
  output_path = "${path.module}/.build/hls_finalize.zip"
}

resource "aws_iam_role" "hls_finalize" {
  name               = "${local.fqname}-hls-finalize"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "hls_finalize_basic" {
  role       = aws_iam_role.hls_finalize.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "hls_finalize_perms" {
  statement {
    sid       = "UpdateAssetsRow"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.assets.arn]
  }
  # HEAD clips/<asset>.mp4 (for size) + GET hls/<asset>/*.m3u8 (for duration).
  statement {
    sid       = "ReadClipsAndHls"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/*"]
  }
}

resource "aws_iam_role_policy" "hls_finalize" {
  role   = aws_iam_role.hls_finalize.id
  policy = data.aws_iam_policy_document.hls_finalize_perms.json
}

resource "aws_lambda_function" "hls_finalize" {
  function_name    = "${local.fqname}-hls-finalize"
  role             = aws_iam_role.hls_finalize.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.hls_finalize.output_path
  source_code_hash = data.archive_file.hls_finalize.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      ASSETS_TABLE      = aws_dynamodb_table.assets.name
      CLIPS_BUCKET      = aws_s3_bucket.clips.bucket
      PLAYBACK_BASE_URL = "https://${aws_cloudfront_distribution.frontend.domain_name}"
    }
  }
}

resource "aws_cloudwatch_log_group" "hls_finalize" {
  name              = "/aws/lambda/${aws_lambda_function.hls_finalize.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "s3_invoke_hls_finalize" {
  statement_id  = "AllowS3InvokeHlsFinalize"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.hls_finalize.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.clips.arn
}
