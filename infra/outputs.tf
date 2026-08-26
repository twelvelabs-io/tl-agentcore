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

output "graph_id" {
  value       = aws_neptunegraph_graph.this.id
  description = "Neptune Analytics graph identifier (g-xxxxxxxxxx). Data-plane calls target {graph_id}.{region}.neptune-graph.amazonaws.com."
}

output "graph_endpoint" {
  value       = aws_neptunegraph_graph.this.endpoint
  description = "Neptune Analytics HTTPS data-plane endpoint for ExecuteQuery / StartImportTask."
}

output "graph_import_role_arn" {
  value       = aws_iam_role.graph_import.arn
  description = "IAM role the graph service assumes for S3 bulk imports. Pass as roleArn to StartImportTask."
}

output "rekognition_collection_prefix" {
  value       = "${local.fqname}-ks-"
  description = "Per-KS Rekognition Faces collection id is <this>+<ks_id>. Lazy-created on first IndexFaces call by the index_faces lambda."
}

output "clips_bucket_name" {
  value       = aws_s3_bucket.clips.bucket
  description = "S3 bucket where mirrored asset bytes live at clips/<asset_id>.mp4. Read by Bedrock Pegasus (runtime) and written by ingest_vectors.py (operator)."
}

# ─── DDB tables (knowledge graph + KS/asset registry) ────────────────────
output "kb_cache_table" {
  value       = aws_dynamodb_table.kb_cache.name
  description = "Single-table cache for the mini-ontology / content-profile layer. Populate via scripts/ingest-kb-cache.py."
}

output "rights_table" {
  value       = aws_dynamodb_table.rights.name
  description = "Licensing + clearance per asset_id. Populate via scripts/seed-rights.py (demo) or wire to an existing rights system."
}

output "audiences_table" {
  value       = aws_dynamodb_table.audiences.name
  description = "Audience-intelligence segments. Populate via scripts/seed-audiences.py."
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

# ─── CloudFront ───────────────────────────────────────────────────────────
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
    VITE_AGENT_RUNTIME_ARN=${aws_bedrockagentcore_agent_runtime.this.agent_runtime_arn}
    VITE_AGENT_RUNTIME_REGION=${var.region}
    VITE_AGENT_RUNTIME_QUALIFIER=${aws_bedrockagentcore_agent_runtime_endpoint.live.name}
    VITE_COGNITO_USER_POOL_ID=${aws_cognito_user_pool.this.id}
    VITE_COGNITO_HOSTED_UI_DOMAIN=https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.region}.amazoncognito.com
    VITE_COGNITO_CLIENT_ID=${aws_cognito_user_pool_client.spa.id}
    VITE_AWS_REGION=${var.region}
    VITE_FRONTEND_URL=https://${aws_cloudfront_distribution.frontend.domain_name}
  EOT
  description = "Paste into ui/.env.production before `npm run build`. The browser uses the user-pool id for the local SRP sign-in flow and the agent runtime ARN for the direct WebSocket."
}
