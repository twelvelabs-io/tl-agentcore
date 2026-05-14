# tl_proxy lambda — generic forwarder for browser-side TL calls.
#
# Browser → CloudFront `/tl/*` → HTTP API Gateway → this lambda → api.twelvelabs.io
#
# Holds the TL API key (read from Secrets Manager); verifies Cognito JWT on
# every request.

locals {
  tl_proxy_root = "${path.module}/../lambda/tl_proxy"
}

data "archive_file" "tl_proxy" {
  type        = "zip"
  source_dir  = local.tl_proxy_root
  output_path = "${path.module}/.build/tl_proxy.zip"
}

data "aws_iam_policy_document" "tl_proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "tl_proxy" {
  name               = "${local.fqname}-tl-proxy"
  assume_role_policy = data.aws_iam_policy_document.tl_proxy_assume.json
}

resource "aws_iam_role_policy_attachment" "tl_proxy_basic" {
  role       = aws_iam_role.tl_proxy.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "tl_proxy_perms" {
  statement {
    sid       = "ReadTLKey"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.tl_api_key.arn]
  }
}

resource "aws_iam_role_policy" "tl_proxy" {
  role   = aws_iam_role.tl_proxy.id
  policy = data.aws_iam_policy_document.tl_proxy_perms.json
}

resource "aws_lambda_function" "tl_proxy" {
  function_name    = "${local.fqname}-tl-proxy"
  role             = aws_iam_role.tl_proxy.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.tl_proxy.output_path
  source_code_hash = data.archive_file.tl_proxy.output_base64sha256
  # Jockey survey calls (1300+ trailer KB) routinely need 90-180s.
  timeout     = 300
  memory_size = 512

  environment {
    variables = {
      TL_API_KEY_SECRET    = aws_secretsmanager_secret.tl_api_key.name
      TL_BASE_URL          = "https://api.twelvelabs.io/v1.3"
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
    }
  }
}

resource "aws_cloudwatch_log_group" "tl_proxy" {
  name              = "/aws/lambda/${aws_lambda_function.tl_proxy.function_name}"
  retention_in_days = 14
}
