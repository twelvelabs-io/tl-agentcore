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

  # Cognito JWT authorizer — replaces the previous SigV4/IAM default so the
  # browser can WS-connect directly to wss://bedrock-agentcore.<region>.
  # amazonaws.com/runtimes/<arn>/ws using the user's access token (via the
  # Sec-WebSocket-Protocol subprotocol trick, since browsers can't set custom
  # headers on the handshake). The chat lambda's SigV4 invocation path stops
  # working when this is set, which is intended — we're cutting it over.
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/openid-configuration"
      allowed_clients = [aws_cognito_user_pool_client.spa.id]
    }
  }

  environment_variables = {
    AGENT_MODEL_ID             = var.agent_model_id
    VECTOR_BUCKET_NAME         = aws_s3vectors_vector_bucket.clips.vector_bucket_name
    VECTOR_INDEX_NAME          = aws_s3vectors_index.clips.index_name
    VECTOR_INDEX_ENTITY_THUMBS = aws_s3vectors_index.entity_thumbs.index_name
    AWS_REGION                 = var.region
    # Pegasus runs on Bedrock against mirrored S3 bytes. No TwelveLabs
    # SaaS involvement on the live path.
    PEGASUS_BEDROCK_MODEL_ID = var.pegasus_bedrock_model_id
    CLIPS_BUCKET_NAME        = aws_s3_bucket.clips.bucket
    CLIPS_BUCKET_OWNER       = data.aws_caller_identity.current.account_id
    # Cache + domain DDB lookups.
    KB_CACHE_TABLE  = aws_dynamodb_table.kb_cache.name
    RIGHTS_TABLE    = aws_dynamodb_table.rights.name
    AUDIENCES_TABLE = aws_dynamodb_table.audiences.name
  }
}

# A versioned, addressable endpoint clients invoke.
#
# CRITICAL: pin `agent_runtime_version` to the live runtime's current version.
# Without it, the AWS provider creates the endpoint pinned at version "1" and
# every subsequent terraform apply that bumps `agent_image_tag` updates the
# runtime to v2/v3/... while the endpoint silently keeps serving v1 — which
# eventually 502s as v1's image tag gets pruned by the ECR lifecycle policy.
# Took a debug cycle to find this; do not remove the attribute.
resource "aws_bedrockagentcore_agent_runtime_endpoint" "live" {
  agent_runtime_id      = aws_bedrockagentcore_agent_runtime.this.agent_runtime_id
  agent_runtime_version = aws_bedrockagentcore_agent_runtime.this.agent_runtime_version
  name                  = "live"
  description           = "Stable invoke target for the tl-agentcore Runtime."
}
