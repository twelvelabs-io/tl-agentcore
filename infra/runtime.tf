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

  # Cognito JWT authorizer — the browser WS-connects directly to
  # wss://bedrock-agentcore.<region>.amazonaws.com/runtimes/<arn>/ws
  # using the user's access token (via the Sec-WebSocket-Protocol
  # subprotocol trick, since browsers can't set custom headers on the
  # handshake). v0.3 removed the legacy chat-lambda relay entirely.
  authorizer_configuration {
    custom_jwt_authorizer {
      discovery_url   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/openid-configuration"
      allowed_clients = [aws_cognito_user_pool_client.spa.id]
    }
  }

  environment_variables = {
    AGENT_MODEL_ID     = var.agent_model_id
    VECTOR_BUCKET_NAME = aws_s3vectors_vector_bucket.clips.vector_bucket_name
    VECTOR_INDEX_NAME  = aws_s3vectors_index.clips.index_name
    AWS_REGION         = var.region
    # Pegasus runs on Bedrock against mirrored S3 bytes. No TwelveLabs
    # SaaS involvement on the live path.
    PEGASUS_BEDROCK_MODEL_ID = var.pegasus_bedrock_model_id
    CLIPS_BUCKET_NAME        = aws_s3_bucket.clips.bucket
    CLIPS_BUCKET_OWNER       = data.aws_caller_identity.current.account_id
    # Cache + domain DDB lookups.
    KB_CACHE_TABLE  = aws_dynamodb_table.kb_cache.name
    RIGHTS_TABLE    = aws_dynamodb_table.rights.name
    AUDIENCES_TABLE = aws_dynamodb_table.audiences.name
    # Multi-turn session scratch (write-only in this release; UI still echoes
    # [CURRENT PLAN]) + long-term per-user memory for the manage_memory /
    # save_tref_to_memory tools.
    SESSIONS_TABLE = aws_dynamodb_table.sessions.name
    MEMORIES_TABLE = aws_dynamodb_table.memories.name
    # PR #8: add_media writes a registration row to the assets table so the
    # agent can bring a new asset into the current KS mid-conversation. The
    # table + its by-ks GSI already exist (kb_admin / enrich lambdas own them);
    # the runtime now gets PutItem on it. Read-side (list_kb_assets, etc.)
    # still goes through kb_cache ASSET# rows, which the batch ingest builds.
    ASSETS_TABLE = aws_dynamodb_table.assets.name
    # PR #10: mining plans. The jockey_save tool writes to JOCKEY_PLANS_TABLE
    # AND creates an EventBridge Schedule in MINING_SCHEDULER_GROUP whose
    # target is MINING_RUN_LAMBDA_ARN, assumed via MINING_SCHEDULER_TARGET_ROLE_ARN.
    # jockey_run invokes the Lambda synchronously; jockey_list_runs reads
    # JOCKEY_RUNS_TABLE.
    JOCKEY_PLANS_TABLE               = aws_dynamodb_table.jockey_plans.name
    JOCKEY_RUNS_TABLE                = aws_dynamodb_table.jockey_runs.name
    MINING_RUN_LAMBDA_ARN            = aws_lambda_function.mining_run.arn
    MINING_SCHEDULER_GROUP           = aws_scheduler_schedule_group.mining.name
    MINING_SCHEDULER_TARGET_ROLE_ARN = aws_iam_role.mining_scheduler_target.arn
    # PR #11: generate_video delegates to the existing stitch MediaConvert
    # lambda via direct lambda:Invoke (HTTP-API-shaped payload), reusing the
    # same job-building code the UI's "Render preview" button hits. generate_html_app
    # uses the Claude Sonnet model already configured via MODEL_ID. execute_code
    # has no external deps.
    STITCH_LAMBDA_ARN = aws_lambda_function.stitch.arn
    # PR #6: durable per-user artifact store (saved plans, generated html-1
    # apps, rendered videos, arbitrary blobs). Small payloads inline, large
    # payloads under `artifacts/<user_id>/<artifact_id>/<name>` in the
    # clips bucket.
    ARTIFACTS_TABLE = aws_dynamodb_table.artifacts.name
    # Wave-2 PR #9: online quality judges. The runtime dispatches a
    # coherence judge (Sonnet) + reference-validity judge (deterministic
    # <plan> parse) fire-and-forget at end-of-turn and writes one row
    # per judge to the scores table. JUDGE_SAMPLE_RATE defaults to 1.0
    # during the calibration window (every turn judged for 1-2 weeks);
    # flip to "0.1" once trends are stable. JUDGE_MODEL_ID defaults to
    # us.anthropic.claude-sonnet-4-6 inside the scoring module.
    SCORES_TABLE      = aws_dynamodb_table.scores.name
    JUDGE_SAMPLE_RATE = "1.0"
    # Wave-2 PR #10: per-tool / per-model metering ledger. One row per
    # Bedrock model turn + per in-process tool call, fire-and-forget.
    # Prices for the cost column live in SSM Parameter Store under
    # /tl-agentcore/prices/<model_id> — ops bumps a rate by writing a
    # new parameter value; PRICES_CACHE_TTL_SECONDS controls how long
    # until the runtime re-reads it (default 15 min).
    USAGE_EVENTS_TABLE       = aws_dynamodb_table.usage_events.name
    PRICES_SSM_PREFIX        = "/tl-agentcore/prices"
    PRICES_CACHE_TTL_SECONDS = "900"
    # Wave-2 PR #4: asset-id handles (`@id_N`) for tool fanout.
    # Opt-in — default off until we validate token savings + solver
    # fidelity on a few turns' trace in usage_events. Flip to "1" via
    # a terraform apply (no redeploy of the agent image needed).
    ID_ALIASES_ENABLED = "0"
    # v0.4 hybrid entity-reID: per-KS Rekognition collection id is
    # derived as `<STACK_FQNAME>-ks-<ks_id>`. Marengo image-embed
    # async-invoke needs the bucket owner for s3Location.bucketOwner.
    STACK_FQNAME   = local.fqname
    AWS_ACCOUNT_ID = data.aws_caller_identity.current.account_id
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
