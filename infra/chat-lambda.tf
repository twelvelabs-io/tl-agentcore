# Chat lambda + its IAM role.
#
# Path B in the architecture: browser ↔ API Gateway WebSocket ↔ chat lambda
# ↔ AgentCore Runtime (or TwelveLabs Jockey, for the comparison demo path).
#
# The lambda has BOTH the $connect/$default WS routes (sync handshake) and
# an async self-invoke pattern for long AgentCore runs (~60-300s). The
# self-invoke escapes the API Gateway WS 30-second integration cap.

locals {
  chat_lambda_root = "${path.module}/../lambda/chat"
}

data "archive_file" "chat" {
  type        = "zip"
  source_dir  = local.chat_lambda_root
  output_path = "${path.module}/.build/chat.zip"
}

# IAM role for the chat lambda
data "aws_iam_policy_document" "chat_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "chat" {
  name               = "${local.fqname}-chat"
  assume_role_policy = data.aws_iam_policy_document.chat_assume.json
}

resource "aws_iam_role_policy_attachment" "chat_basic" {
  role       = aws_iam_role.chat.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "chat_perms" {
  # Invoke AgentCore Runtime.
  statement {
    sid = "InvokeAgentCore"
    actions = [
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:GetAgentRuntime",
    ]
    resources = [
      aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn,
      "${aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn}/*",
    ]
  }
  # Read the TL API key (for the Jockey-direct comparison path).
  statement {
    sid       = "ReadTLKey"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.tl_api_key.arn]
  }
  # Self-invoke (async pattern that escapes the WS 30s integration cap).
  statement {
    sid     = "SelfInvoke"
    actions = ["lambda:InvokeFunction"]
    resources = [
      # Resolved at apply time. We use a wildcard on the function family
      # so the policy doesn't depend on the function arn (avoids cycle).
      "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.fqname}-chat",
    ]
  }
  # Post messages back to the WebSocket connection.
  statement {
    sid     = "WsPost"
    actions = ["execute-api:ManageConnections"]
    resources = [
      "${aws_apigatewayv2_api.ws.execution_arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "chat" {
  role   = aws_iam_role.chat.id
  policy = data.aws_iam_policy_document.chat_perms.json
}

resource "aws_lambda_function" "chat" {
  function_name    = "${local.fqname}-chat"
  role             = aws_iam_role.chat.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.chat.output_path
  source_code_hash = data.archive_file.chat.output_base64sha256
  # 5-minute lambda ceiling. The async self-invoke uses the full budget for
  # long AgentCore runs while the sync $default returns in <1s.
  timeout     = 300
  memory_size = 1024

  environment {
    variables = {
      AGENTCORE_RUNTIME_ARN = aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn
      COGNITO_USER_POOL_ID  = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID     = aws_cognito_user_pool_client.spa.id
      TL_API_KEY_SECRET     = aws_secretsmanager_secret.tl_api_key.name
      TL_BASE_URL           = "https://api.twelvelabs.io/v1.3"
    }
  }
}

resource "aws_cloudwatch_log_group" "chat" {
  name              = "/aws/lambda/${aws_lambda_function.chat.function_name}"
  retention_in_days = 14
}

# Disable async-invocation retries — the self-invoke path is at-most-once
# semantically (a duplicate run would post duplicate messages to the WS).
resource "aws_lambda_function_event_invoke_config" "chat" {
  function_name                = aws_lambda_function.chat.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}
