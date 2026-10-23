# plugins lambda + DDB table.
#
# One row per customer-added data source. The lambda handles /plugins
# CRUD; create/delete also mutate the AgentCore Gateway's target list
# via bedrock-agentcore-control SDK so the runtime discovers the new
# tools on its next build.
#
# Reference plugin (plugin_echo) is NOT managed through this lambda —
# it's a Terraform-owned gateway target (plugin-echo-target.tf), so it
# survives DDB wipes and provides a stable health-check tool. The
# plugins table lists only user-added plugins.

# ─── DDB table ────────────────────────────────────────────────────────
resource "aws_dynamodb_table" "plugins" {
  name         = "${local.fqname}-plugins"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "plugin_id"

  point_in_time_recovery { enabled = true }

  attribute {
    name = "plugin_id"
    type = "S"
  }
}

# ─── Lambda ───────────────────────────────────────────────────────────
locals {
  plugins_root = "${path.module}/../lambda/plugins"
}

data "archive_file" "plugins" {
  type        = "zip"
  source_dir  = local.plugins_root
  output_path = "${path.module}/.build/plugins.zip"
}

resource "aws_iam_role" "plugins" {
  name               = "${local.fqname}-plugins"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "plugins_basic" {
  role       = aws_iam_role.plugins.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "plugins_perms" {
  statement {
    sid = "PluginsTableRW"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
    ]
    resources = [aws_dynamodb_table.plugins.arn]
  }
  statement {
    sid = "GatewayTargetCRUD"
    actions = [
      "bedrock-agentcore:CreateGatewayTarget",
      "bedrock-agentcore:DeleteGatewayTarget",
      "bedrock-agentcore:GetGatewayTarget",
      "bedrock-agentcore:ListGatewayTargets",
    ]
    resources = [
      aws_bedrockagentcore_gateway.plugins.gateway_arn,
      "${aws_bedrockagentcore_gateway.plugins.gateway_arn}/target/*",
    ]
  }
  # Credential-provider CRUD. Needed when a customer registers an
  # OpenAPI target with api_key / bearer / basic auth — the lambda
  # provisions a per-plugin api_key_credential_provider holding the
  # stored secret, and tears it down on DELETE.
  statement {
    sid = "CredentialProviderCRUD"
    actions = [
      "bedrock-agentcore:CreateApiKeyCredentialProvider",
      "bedrock-agentcore:DeleteApiKeyCredentialProvider",
      "bedrock-agentcore:GetApiKeyCredentialProvider",
      "bedrock-agentcore:ListApiKeyCredentialProviders",
    ]
    resources = ["*"]
  }
  # Create/DeleteApiKeyCredentialProvider internally creates a
  # Secrets Manager secret under `bedrock-agentcore-identity!*` to
  # back the stored key. Give the lambda just enough to let the
  # control-plane call succeed — the lambda never reads or writes the
  # secret directly, Gateway's control plane does.
  statement {
    sid = "CredentialProviderSecret"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:TagResource",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
    ]
    resources = ["arn:aws:secretsmanager:*:*:secret:bedrock-agentcore-identity!*"]
  }
  # The lambda hands the gateway a role_arn (the gateway's own role,
  # via GATEWAY_IAM_ROLE credential provider), so no iam:PassRole here.
}

resource "aws_iam_role_policy" "plugins" {
  role   = aws_iam_role.plugins.id
  policy = data.aws_iam_policy_document.plugins_perms.json
}

resource "aws_lambda_function" "plugins" {
  function_name    = "${local.fqname}-plugins"
  role             = aws_iam_role.plugins.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.plugins.output_path
  source_code_hash = data.archive_file.plugins.output_base64sha256
  timeout          = 20
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      PLUGINS_TABLE        = aws_dynamodb_table.plugins.name
      GATEWAY_ID           = aws_bedrockagentcore_gateway.plugins.gateway_id
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      ADMIN_GROUP_NAME     = aws_cognito_user_group.admins.name
    }
  }
}

resource "aws_cloudwatch_log_group" "plugins" {
  name              = "/aws/lambda/${aws_lambda_function.plugins.function_name}"
  retention_in_days = 14
}

# ─── HTTP API routes /plugins* → plugins lambda ──────────────────────
resource "aws_apigatewayv2_integration" "plugins" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.plugins.invoke_arn
  payload_format_version = "2.0"
}

locals {
  plugins_routes = [
    "GET /plugins",
    "POST /plugins",
    "OPTIONS /plugins",
    "DELETE /plugins/{id}",
    "OPTIONS /plugins/{id}",
  ]
}

resource "aws_apigatewayv2_route" "plugins" {
  for_each  = toset(local.plugins_routes)
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.plugins.id}"
}

resource "aws_lambda_permission" "http_invoke_plugins" {
  statement_id  = "AllowHttpInvokePlugins"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.plugins.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
