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
  description = "Bedrock cross-region inference profile for the Strands orchestrator. With profile_cache pre-built, the agent finishes in fewer turns so the per-turn latency hit is offset."
}

variable "tl_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "TwelveLabs API key. Stored in Secrets Manager; the runtime reads it at startup. Leave blank to manage the secret out-of-band."
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
