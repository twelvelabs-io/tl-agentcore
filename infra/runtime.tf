# AgentCore Runtime + ECR repo for the Strands agent container.
#
# Build/push flow lives in build-agent.sh. Terraform owns the repo and the
# runtime resource; the script pushes the image. After the first apply, the
# runtime is created pointing at a not-yet-pushed image; build-agent.sh
# pushes (with a fresh tag), then a second `terraform apply -var
# agent_image_tag=v<ts>` wires it up.

resource "aws_ecr_repository" "agent" {
  name                 = "${local.fqname}-agent"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }
}

resource "aws_ecr_lifecycle_policy" "agent" {
  repository = aws_ecr_repository.agent.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep last 5 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

locals {
  agent_image_uri = "${aws_ecr_repository.agent.repository_url}:${var.agent_image_tag}"
}

resource "aws_bedrockagentcore_agent_runtime" "this" {
  agent_runtime_name = replace("${local.fqname}-agent", "-", "_")
  role_arn           = aws_iam_role.runtime.arn
  description        = "tl-agentcore — Strands agent for Rough Cut / Highlight Reel workflows."

  agent_runtime_artifact {
    container_configuration {
      container_uri = local.agent_image_uri
    }
  }

  network_configuration {
    network_mode = "PUBLIC"
  }

  protocol_configuration {
    server_protocol = "HTTP"
  }

  # No authorizer block → defaults to SigV4/IAM auth. Callers (a chat lambda,
  # a CLI, an EKS workload) invoke this with their IAM role. To accept
  # Cognito JWTs directly, add an authorizer_configuration.custom_jwt_authorizer.

  environment_variables = {
    AGENT_MODEL_ID    = var.agent_model_id
    TL_API_KEY_SECRET = aws_secretsmanager_secret.tl_api_key.name
    PROFILE_CACHE_TABLE    = aws_dynamodb_table.profile_cache.name
    AWS_REGION        = var.region
  }
}

# A versioned, addressable endpoint clients invoke.
resource "aws_bedrockagentcore_agent_runtime_endpoint" "live" {
  agent_runtime_id = aws_bedrockagentcore_agent_runtime.this.agent_runtime_id
  name             = "live"
  description      = "Stable invoke target for the tl-agentcore Runtime."
}
