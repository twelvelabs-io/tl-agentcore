# users lambda — admin-only Cognito user CRUD for the SPA's Settings →
# Users tab. JWT verification + admins-group gate. Surfaces:
#   GET    /users
#   POST   /users
#   DELETE /users/{username}
#   POST   /users/{username}/{action}  (reset-password, resend-invite,
#                                       enable, disable)
#
# Browser → CloudFront /users/* → HTTP API → this lambda → Cognito admin APIs.

locals {
  users_root = "${path.module}/../lambda/users"
}

data "archive_file" "users" {
  type        = "zip"
  source_dir  = local.users_root
  output_path = "${path.module}/.build/users.zip"
}

resource "aws_iam_role" "users" {
  name               = "${local.fqname}-users"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "users_basic" {
  role       = aws_iam_role.users.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "users_perms" {
  statement {
    sid     = "CognitoUserAdmin"
    actions = [
      "cognito-idp:ListUsers",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminDeleteUser",
      "cognito-idp:AdminResetUserPassword",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminListGroupsForUser",
    ]
    resources = [aws_cognito_user_pool.this.arn]
  }
}

resource "aws_iam_role_policy" "users" {
  role   = aws_iam_role.users.id
  policy = data.aws_iam_policy_document.users_perms.json
}

resource "aws_lambda_function" "users" {
  function_name    = "${local.fqname}-users"
  role             = aws_iam_role.users.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.users.output_path
  source_code_hash = data.archive_file.users.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      ADMIN_GROUP_NAME     = "admins"
    }
  }
}

resource "aws_cloudwatch_log_group" "users" {
  name              = "/aws/lambda/${aws_lambda_function.users.function_name}"
  retention_in_days = 14
}

# ─── HTTP API routes /users/* → users lambda ──────────────────────────
resource "aws_apigatewayv2_integration" "users" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.users.invoke_arn
  payload_format_version = "2.0"
}

locals {
  users_routes = [
    "GET /users",
    "POST /users",
    "OPTIONS /users",
    "DELETE /users/{username}",
    "OPTIONS /users/{username}",
    "POST /users/{username}/{action}",
    "OPTIONS /users/{username}/{action}",
  ]
}

resource "aws_apigatewayv2_route" "users" {
  for_each  = toset(local.users_routes)
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.users.id}"
}

resource "aws_lambda_permission" "http_invoke_users" {
  statement_id  = "AllowHttpInvokeUsers"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.users.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
