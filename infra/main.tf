# tl-agentcore — standalone Terraform stack for the Rough Cut / Highlight
# Reel reference architecture. AWS provider 6.x (required for the
# aws_bedrockagentcore_* resources — v5.x has zero coverage).
#
# What this stack stands up:
#   - ECR repo for the Strands agent container (linux/arm64)
#   - AgentCore Runtime + endpoint
#   - kb_cache DDB table (Tier-1 cache from the whitepaper)
#   - Secrets Manager entry for the TwelveLabs API key
#   - IAM roles (runtime + ECR pull + DDB read + Bedrock invoke + secret read)
#
# What's NOT here yet (deliberately Phase-2):
#   - AgentCore Gateway. The agent runs with in-process tools by default.
#     Adding Gateway means moving the tools into MCP-serving lambdas and
#     wiring them as targets. See docs/whitepaper.md §6.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws",    version = "~> 6.43" }
    random = { source = "hashicorp/random", version = "~> 3.6"  }
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
data "aws_region"          "current" {}

resource "random_id" "stack" {
  byte_length = 3
}

locals {
  fqname = "${var.project_name}-${random_id.stack.hex}"
}
