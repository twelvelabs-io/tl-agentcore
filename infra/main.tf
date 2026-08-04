# tl-agentcore — standalone Terraform stack for the Rough Cut / Highlight
# Reel reference architecture. AWS provider 6.x (required for the
# aws_bedrockagentcore_* resources — v5.x has zero coverage).
#
# What this stack stands up:
#   - ECR repo for the Strands agent container (linux/arm64)
#   - AgentCore Runtime + endpoint
#   - S3 Vectors bucket + index for Marengo clip embeddings (see whitepaper §4)
#   - Secrets Manager entry for the TwelveLabs API key
#   - IAM roles (runtime + ECR pull + s3vectors query + Bedrock invoke + secret read)
#
# What's NOT here yet (deliberately Phase-2):
#   - AgentCore Gateway. The agent runs with in-process tools by default.
#     Adding Gateway means moving the tools into MCP-serving lambdas and
#     wiring them as targets. See docs/whitepaper.md §6.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.43" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = {
      Project = var.project_name
      Layer   = "tl-agentcore"
    }
  }
}

data "aws_caller_identity" "current" {}

resource "random_id" "stack" {
  byte_length = 3
}

locals {
  fqname = "${var.project_name}-${random_id.stack.hex}"
}
