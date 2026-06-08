# stitch lambda — assembles an EDL into a single preview MP4 via
# MediaConvert. UI's "Render preview" button POSTs the plan and polls
# this lambda for progress.
#
# Browser → CloudFront `/stitch*` → HTTP API → this lambda → MediaConvert.
# Output lands at s3://<clips>/stitched/<job_id>/*_preview.mp4 and is
# served back through CloudFront `/stitched/*`.

locals {
  stitch_root = "${path.module}/../lambda/stitch"
}

data "archive_file" "stitch" {
  type        = "zip"
  source_dir  = local.stitch_root
  output_path = "${path.module}/.build/stitch.zip"
}

resource "aws_iam_role" "stitch" {
  name               = "${local.fqname}-stitch"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "stitch_basic" {
  role       = aws_iam_role.stitch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "stitch_perms" {
  statement {
    sid     = "MediaConvertJob"
    actions = ["mediaconvert:DescribeEndpoints", "mediaconvert:CreateJob", "mediaconvert:GetJob"]
    resources = ["*"]
  }
  statement {
    sid     = "PassMediaConvertRole"
    actions = ["iam:PassRole"]
    resources = [aws_iam_role.mediaconvert.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["mediaconvert.amazonaws.com"]
    }
  }
  # When MediaConvert's GetJob response omits OutputFilePaths (rare but
  # observed), the lambda lists the stitched/<jobId>/ prefix to find the
  # actual MP4 key MC wrote.
  statement {
    sid     = "ListStitchedOutputs"
    actions = ["s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["stitched/*"]
    }
  }
}

resource "aws_iam_role_policy" "stitch" {
  role   = aws_iam_role.stitch.id
  policy = data.aws_iam_policy_document.stitch_perms.json
}

resource "aws_lambda_function" "stitch" {
  function_name    = "${local.fqname}-stitch"
  role             = aws_iam_role.stitch.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.stitch.output_path
  source_code_hash = data.archive_file.stitch.output_base64sha256
  timeout          = 30
  memory_size      = 512

  environment {
    variables = {
      CLIPS_BUCKET          = aws_s3_bucket.clips.bucket
      MEDIACONVERT_ROLE_ARN = aws_iam_role.mediaconvert.arn
      PLAYBACK_BASE_URL     = "https://${aws_cloudfront_distribution.frontend.domain_name}"
      COGNITO_USER_POOL_ID  = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID     = aws_cognito_user_pool_client.spa.id
    }
  }
}

resource "aws_cloudwatch_log_group" "stitch" {
  name              = "/aws/lambda/${aws_lambda_function.stitch.function_name}"
  retention_in_days = 14
}

resource "aws_apigatewayv2_integration" "stitch" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.stitch.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "stitch_post" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /stitch"
  target    = "integrations/${aws_apigatewayv2_integration.stitch.id}"
}

resource "aws_apigatewayv2_route" "stitch_get" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /stitch/{jobId}"
  target    = "integrations/${aws_apigatewayv2_integration.stitch.id}"
}

resource "aws_apigatewayv2_route" "stitch_options" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "OPTIONS /stitch"
  target    = "integrations/${aws_apigatewayv2_integration.stitch.id}"
}

resource "aws_apigatewayv2_route" "stitch_options_id" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "OPTIONS /stitch/{jobId}"
  target    = "integrations/${aws_apigatewayv2_integration.stitch.id}"
}

resource "aws_lambda_permission" "http_invoke_stitch" {
  statement_id  = "AllowHttpInvokeStitch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.stitch.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
