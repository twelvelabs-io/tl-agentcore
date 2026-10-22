# scores lambda — surfaces online judge rows to the SPA.
#
# The runtime writes to the scores DDB table fire-and-forget at
# end-of-turn (see agent/tl_agentcore/scoring/judge_runner.py). This
# lambda is read-side: given a response_id, it queries the table and
# returns the matching judges (coherence + reference_validity) to the
# UI's trace panel.
#
# Browser → CloudFront `/scores/{response_id}` → HTTP API Gateway → this lambda → DDB.

locals {
  scores_root = "${path.module}/../lambda/scores"
}

data "archive_file" "scores" {
  type        = "zip"
  source_dir  = local.scores_root
  output_path = "${path.module}/.build/scores.zip"
}

data "aws_iam_policy_document" "scores_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scores" {
  name               = "${local.fqname}-scores"
  assume_role_policy = data.aws_iam_policy_document.scores_assume.json
}

resource "aws_iam_role_policy_attachment" "scores_basic" {
  role       = aws_iam_role.scores.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "scores_perms" {
  # Read-only Query on scores — the lambda never writes. Judge writes go
  # directly from the runtime, keyed on (response_id, judge_name).
  statement {
    sid       = "QueryScoresByResponseId"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.scores.arn]
  }
}

resource "aws_iam_role_policy" "scores" {
  role   = aws_iam_role.scores.id
  policy = data.aws_iam_policy_document.scores_perms.json
}

resource "aws_lambda_function" "scores" {
  function_name    = "${local.fqname}-scores"
  role             = aws_iam_role.scores.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.scores.output_path
  source_code_hash = data.archive_file.scores.output_base64sha256
  timeout          = 10
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      SCORES_TABLE         = aws_dynamodb_table.scores.name
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      ADMIN_GROUP_NAME     = aws_cognito_user_group.admins.name
    }
  }
}

resource "aws_cloudwatch_log_group" "scores" {
  name              = "/aws/lambda/${aws_lambda_function.scores.function_name}"
  retention_in_days = 14
}

# ─── HTTP API route /scores/{response_id} → scores lambda ────────────────
resource "aws_apigatewayv2_integration" "scores" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.scores.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "scores_get" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /scores/{response_id}"
  target    = "integrations/${aws_apigatewayv2_integration.scores.id}"
}

resource "aws_apigatewayv2_route" "scores_options" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "OPTIONS /scores/{response_id}"
  target    = "integrations/${aws_apigatewayv2_integration.scores.id}"
}

resource "aws_lambda_permission" "http_invoke_scores" {
  statement_id  = "AllowHttpInvokeScores"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scores.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
