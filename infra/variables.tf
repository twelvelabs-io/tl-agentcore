variable "region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  type        = string
  default     = "default"
  description = "Named AWS profile to use (matches your ~/.aws/credentials)."
}

variable "project_name" {
  type        = string
  default     = "tl-agentcore"
  description = "Used as a prefix for every named resource."
}

variable "agent_model_id" {
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
  description = "Bedrock cross-region inference profile for the Strands orchestrator."
}

# The container URI Terraform feeds the AgentCore Runtime. AgentCore caches
# the resolved digest of `:latest` at create/update time and doesn't
# re-resolve when the URI string is unchanged — so pushing a new image to
# `:latest` alone won't update a deployed runtime. Bump this tag per build
# (build-agent.sh writes a `:v<timestamp>` tag every push) to force a
# digest refetch.
variable "agent_image_tag" {
  type        = string
  default     = "v0"
  description = "ECR image tag the AgentCore Runtime points at. Bump on every container build."
}

variable "seed_admin_email" {
  type        = string
  default     = ""
  description = "Email of the first admin user. Cognito emails them an invite + temporary password on first apply. Leave blank to skip and add users manually."
}

variable "pegasus_bedrock_model_id" {
  type        = string
  default     = "us.twelvelabs.pegasus-1-2-v1:0"
  description = "Bedrock model id for Pegasus when pegasus_provider = 'bedrock'. Defaults to the us cross-region inference profile of Pegasus 1.2."
}

# Frontend origin for CORS narrowing. Chicken-and-egg with the
# CloudFront distribution — set to null on the first apply, then run
# `terraform apply -var frontend_domain="$(terraform output -raw frontend_url | sed 's|https://||')"`
# to lock CORS down to the actual SPA origin. See
# docs/deployment.md#tighten-cors for the exact sequence.
variable "frontend_domain" {
  type        = string
  default     = null
  description = "CloudFront domain that hosts the SPA (no scheme). Set after first apply to narrow API GW CORS from `*` to the specific origin. Empty/null keeps the wildcard."
}

# Neptune Analytics has no serverless tier — the graph bills continuously
# once created. 32 m-NCU is the smallest useful config (each m-NCU ≈ 1 GiB
# memory, ~$0.16/m-NCU-hr in us-east-1). Bump for larger graphs or higher
# query concurrency.
variable "graph_provisioned_memory" {
  type        = number
  default     = 32
  description = "Neptune Analytics graph size in m-NCU (min 32). Affects hourly cost — expect ~$5/hr at the floor."
}
