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

output "kb_cache_table" {
  value       = aws_dynamodb_table.kb_cache.name
  description = "DynamoDB table holding the Tier-1 cache. Pass to scripts/ingest_kb_cache.py."
}

output "tl_api_key_secret" {
  value       = aws_secretsmanager_secret.tl_api_key.name
  description = "Secrets Manager id of the TL API key the runtime reads at startup."
}
