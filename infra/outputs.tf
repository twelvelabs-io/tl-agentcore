output "agent_ecr_url" {
  value       = aws_ecr_repository.agent.repository_url
  description = "ECR repo for the Strands agent container. Passed to build-agent.sh."
}

output "agent_runtime_arn" {
  value       = aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn
  description = "AgentCore Runtime ARN — pass to InvokeAgentRuntime."
}

output "agent_runtime_id" {
  value = aws_bedrockagentcore_agent_runtime.this.agent_runtime_id
}

output "agent_runtime_endpoint_arn" {
  value = aws_bedrockagentcore_agent_runtime_endpoint.live.agent_runtime_endpoint_arn
}

output "runtime_role_arn" {
  value = aws_iam_role.runtime.arn
}

output "vector_bucket_name" {
  value       = aws_s3vectors_vector_bucket.clips.vector_bucket_name
  description = "S3 Vectors bucket holding Marengo clip embeddings. Passed to the agent runtime and the ingest script."
}

output "vector_index_name" {
  value       = aws_s3vectors_index.clips.index_name
  description = "S3 Vectors index name (single index per bucket; KS scoping is done via metadata filter)."
}

output "tl_api_key_secret" {
  value       = aws_secretsmanager_secret.tl_api_key.name
  description = "Secrets Manager id of the TL API key the runtime reads at startup."
}

# ─── Cognito ─────────────────────────────────────────────────────────────
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.spa.id
}

output "cognito_hosted_ui_domain" {
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.region}.amazoncognito.com"
  description = "Hosted UI base URL (with https:// — the UI feeds this into new URL() so the protocol is required)."
}

# ─── WebSocket + CloudFront ───────────────────────────────────────────────
output "ws_api_url" {
  value       = "${aws_apigatewayv2_api.ws.api_endpoint}/${aws_apigatewayv2_stage.ws_live.name}"
  description = "Direct WebSocket URL (wss://...). The UI normally hits the CloudFront-fronted path instead."
}

output "frontend_url" {
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
  description = "Public URL of the demo UI."
}

output "frontend_bucket" {
  value       = aws_s3_bucket.frontend.bucket
  description = "S3 bucket for built UI assets. `aws s3 sync ui/dist s3://<bucket>/`."
}

output "cloudfront_distribution_id" {
  value       = aws_cloudfront_distribution.frontend.id
  description = "Used by `aws cloudfront create-invalidation` after a UI deploy."
}

# ─── UI build env (the four lines the UI's .env.production needs) ─────────
output "ui_env" {
  value       = <<-EOT
    VITE_AGENT_WS_URL=wss://${aws_cloudfront_distribution.frontend.domain_name}/live
    VITE_COGNITO_HOSTED_UI_DOMAIN=https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.region}.amazoncognito.com
    VITE_COGNITO_CLIENT_ID=${aws_cognito_user_pool_client.spa.id}
    VITE_FRONTEND_URL=https://${aws_cloudfront_distribution.frontend.domain_name}
  EOT
  description = "Paste into ui/.env.production before `npm run build`."
}
