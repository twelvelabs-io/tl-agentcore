# Phase 2 — AgentCore Gateway as MCP front for the agent's tools.
#
# In Phase 1 (this skeleton) the agent runs with in-process tools — the
# Strands agent in agent/tl_agentcore/agent.py holds the implementations and
# the Runtime container is everything. That's the simplest deployment and
# enough for the whitepaper's demo.
#
# In Phase 2, the tools move out of the container into:
#   1. Per-tool Lambda functions (or one router lambda).
#   2. An aws_bedrockagentcore_gateway with CUSTOM_JWT auth (Cognito).
#   3. aws_bedrockagentcore_gateway_target resources, each declaring an
#      inline MCP tool schema and pointing at its lambda.
#   4. The runtime container reads GATEWAY_MCP_URL and ACCESS_TOKEN to
#      reach the gateway (the build_agent() helper already supports this
#      path — see agent/tl_agentcore/agent.py).
#
# Reference shape (from an earlier internal stack — not enabled here):
#
#   resource "aws_bedrockagentcore_gateway" "this" {
#     name             = "${local.fqname}-gw"
#     role_arn         = aws_iam_role.gateway.arn
#     protocol_type    = "MCP"
#     authorizer_type  = "CUSTOM_JWT"
#     authorizer_configuration {
#       custom_jwt_authorizer {
#         discovery_url   = "https://cognito-idp.${var.region}.amazonaws.com/${cognito_pool_id}/.well-known/openid-configuration"
#         allowed_clients = [cognito_client_id]
#       }
#     }
#     protocol_configuration {
#       mcp {
#         supported_versions = ["2025-03-26"]
#       }
#     }
#   }
#
# When you're ready to enable Gateway, uncomment + flesh out, add Cognito
# resources, and create one gateway_target per agent tool.
