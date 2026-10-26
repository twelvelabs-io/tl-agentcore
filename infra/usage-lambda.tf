# usage lambda — surfaces metering-ledger events to the SPA.
#
# The runtime writes one row per Bedrock model invocation + per
# in-process tool call to the usage_events DDB table, fire-and-forget
# (see agent/tl_agentcore/metering/ledger.py). This lambda is read-side:
# given a time window and an optional user_id, it queries the table and
# returns the events + a per-model / per-tool summary.
#
# Browser → CloudFront `/usage` → HTTP API Gateway → this lambda → DDB.

locals {
  usage_root = "${path.module}/../lambda/usage"
}

data "archive_file" "usage" {
  type        = "zip"
  source_dir  = local.usage_root
  output_path = "${path.module}/.build/usage.zip"
}

data "aws_iam_policy_document" "usage_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "usage" {
  name               = "${local.fqname}-usage"
  assume_role_policy = data.aws_iam_policy_document.usage_assume.json
}

resource "aws_iam_role_policy_attachment" "usage_basic" {
  role       = aws_iam_role.usage.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "usage_perms" {
  # Read-only Query on usage_events — the lambda never writes. Writes
  # come directly from the runtime's metering ledger.
  statement {
    sid       = "QueryUsageEventsByUser"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.usage_events.arn]
  }
}

resource "aws_iam_role_policy" "usage" {
  role   = aws_iam_role.usage.id
  policy = data.aws_iam_policy_document.usage_perms.json
}

resource "aws_lambda_function" "usage" {
  function_name    = "${local.fqname}-usage"
  role             = aws_iam_role.usage.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.usage.output_path
  source_code_hash = data.archive_file.usage.output_base64sha256
  timeout          = 10
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      USAGE_EVENTS_TABLE   = aws_dynamodb_table.usage_events.name
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      ADMIN_GROUP_NAME     = aws_cognito_user_group.admins.name
    }
  }
}

resource "aws_cloudwatch_log_group" "usage" {
  name              = "/aws/lambda/${aws_lambda_function.usage.function_name}"
  retention_in_days = 14
}

# ─── HTTP API route /usage → usage lambda ────────────────────────────────
resource "aws_apigatewayv2_integration" "usage" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.usage.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "usage_get" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /usage"
  target    = "integrations/${aws_apigatewayv2_integration.usage.id}"
}

resource "aws_apigatewayv2_route" "usage_options" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "OPTIONS /usage"
  target    = "integrations/${aws_apigatewayv2_integration.usage.id}"
}

resource "aws_lambda_permission" "http_invoke_usage" {
  statement_id  = "AllowHttpInvokeUsage"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.usage.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
