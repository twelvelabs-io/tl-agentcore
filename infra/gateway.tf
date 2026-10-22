# AgentCore Gateway — MCP front for customer-pluggable data sources.
#
# This is the plugin surface the Distribution-Readiness feature builds
# on. Each registered gateway *target* is one external data source
# (customer-brought Lambda, OpenAPI endpoint, or the reference MCP
# servers we ship). The gateway aggregates every target's tools behind
# a single MCP endpoint; the runtime connects to that endpoint and
# merges those tools in with its in-process tool list in
# agent/tl_agentcore/agent.py:build_agent.
#
# Targets are NOT managed here. They're created and destroyed by the
# plugins lambda (lambda/plugins/) in response to CRUD calls against
# the plugins DDB table. Terraform owns the gateway itself and the
# gateway's execution role (trust + lambda:InvokeFunction on every
# tl-agentcore stack lambda, so target creation doesn't need an IAM
# round-trip).

# Trust policy — gateway service assumes this role when invoking
# downstream Lambda targets. Same shape as the runtime role; we
# intentionally omit aws:SourceAccount for the reason noted in
# iam.tf.
data "aws_iam_policy_document" "gateway_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "gateway" {
  name               = "${local.fqname}-gateway"
  assume_role_policy = data.aws_iam_policy_document.gateway_assume.json
}

# Gateway invokes its Lambda targets through this role. We allow
# InvokeFunction on any Lambda in this stack's name prefix so a new
# plugin target can be created without a Terraform round-trip to
# attach the ARN; each actual Lambda target also needs an
# `aws_lambda_permission` granting bedrock-agentcore.amazonaws.com
# invoke, which the plugins lambda creates (or Terraform does for the
# reference targets we ship ourselves).
data "aws_iam_policy_document" "gateway_perms" {
  statement {
    sid       = "InvokePluginTargets"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.fqname}-*"]
  }
  statement {
    sid = "Cloudwatch"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/*",
      "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/*:log-stream:*",
    ]
  }
}

resource "aws_iam_role_policy" "gateway" {
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.gateway_perms.json
}

resource "aws_bedrockagentcore_gateway" "plugins" {
  name            = "${local.fqname}-plugins"
  role_arn        = aws_iam_role.gateway.arn
  authorizer_type = "CUSTOM_JWT"
  description     = "Pluggable data-source surface. Targets added by the plugins lambda."

  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/openid-configuration"
      allowed_clients = [aws_cognito_user_pool_client.spa.id]
    }
  }

  protocol_configuration {
    mcp {
      supported_versions = ["2025-03-26"]
    }
  }
}

# Runtime needs the gateway URL + Cognito token to connect; the token
# comes from the Sec-WebSocket-Protocol subprotocol already in use by
# the browser flow (runtime.py forwards it into build_agent via
# `access_token`).
output "gateway_mcp_url" {
  value       = aws_bedrockagentcore_gateway.plugins.gateway_url
  description = "MCP endpoint the runtime connects to; also exported into runtime env as GATEWAY_MCP_URL."
}

output "gateway_id" {
  value       = aws_bedrockagentcore_gateway.plugins.gateway_id
  description = "Gateway identifier the plugins lambda uses when calling CreateGatewayTarget / DeleteGatewayTarget."
}
