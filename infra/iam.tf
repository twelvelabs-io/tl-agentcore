# Runtime role: AgentCore Runtime executes the agent container under this.
#
# Trust policy works with `Service: bedrock-agentcore.amazonaws.com` alone.
# Adding `aws:SourceAccount` here triggers "Gateway service is not authorized
# to perform AssumeRole" at gateway-target creation in some accounts — we
# leave it off for portability.

data "aws_iam_policy_document" "runtime_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
  }
}

# Shared assume-role policy for any Lambda function in this stack.
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "runtime" {
  name               = "${local.fqname}-runtime"
  assume_role_policy = data.aws_iam_policy_document.runtime_assume.json
}

data "aws_iam_policy_document" "runtime_perms" {
  # Pull the container image at runtime start.
  # ECR pull is split: `GetAuthorizationToken` is a service-level API
  # with no resource ARN (must be `*`); the three read actions are
  # scoped to the specific agent repo.
  statement {
    sid       = "EcrGetAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPullAgentRepo"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchCheckLayerAvailability",
    ]
    resources = [aws_ecr_repository.agent.arn]
  }
  # CloudWatch Logs — narrow to the runtime's log group. AgentCore
  # creates a log group `bedrock-agentcore/runtimes/<runtime-id>-*`
  # under the account, so we grant the log-group wildcard scoped to
  # the current account/region.
  statement {
    sid = "Cloudwatch"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/*",
      "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/bedrock-agentcore/*:log-stream:*",
    ]
  }
  # Invoke the Bedrock model + the cross-region inference profile.
  # Narrowed to just the three models the agent actually uses:
  #   - Claude Sonnet 4.6 (agent reasoner)
  #   - Marengo 3.0 (embeddings for vector_search / find_by_image)
  #   - Pegasus 1.5 (per-clip video analysis; 1.2 kept allow-listed for rollback via pegasus_bedrock_model_id)
  # us.* inference profiles need permissions on BOTH the profile ARN
  # (the caller-facing id) AND every regional foundation-model ARN it
  # can route to (the actual model), so we grant both.
  statement {
    sid = "BedrockInvoke"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:GetInferenceProfile",
      "bedrock:GetFoundationModel",
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*",
      "arn:aws:bedrock:*::foundation-model/twelvelabs.marengo-embed-3-0-v1:0",
      "arn:aws:bedrock:*::foundation-model/twelvelabs.pegasus-1-2-v1:0",
      "arn:aws:bedrock:*::foundation-model/twelvelabs.pegasus-1-5-v1:0",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.claude-sonnet-4-6*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.twelvelabs.marengo-embed-3-0-v1:0",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.twelvelabs.pegasus-1-2-v1:0",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.twelvelabs.pegasus-1-5-v1:0",
    ]
  }
  # Query the S3 Vectors index. QueryVectors + GetVectors are required to
  # use metadata filters and return metadata in the response.
  statement {
    sid = "QueryVectorIndex"
    actions = [
      "s3vectors:QueryVectors",
      "s3vectors:GetVectors",
    ]
    resources = [
      aws_s3vectors_vector_bucket.clips.vector_bucket_arn,
      "${aws_s3vectors_vector_bucket.clips.vector_bucket_arn}/index/*",
    ]
  }
  # Read mirrored clip bytes so Bedrock can fetch them for Pegasus
  # analysis. Bedrock InvokeModel with s3Location requires the caller
  # principal (this runtime role) to have s3:GetObject on the URI.
  statement {
    sid       = "ReadClipBytes"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/*"]
  }
  # find_by_image's Marengo fallback needs to list objects under
  # async-out-eval/<invocationId>/ to find the output.json — Bedrock
  # names its async output prefix at invocation time, so the agent
  # can't compose the key up-front.
  statement {
    sid       = "ListClipsBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn]
  }
  # Marengo async image-embed (find_by_image fallback): the agent
  # uploads the reference image to async-in-eval/ + an embed-cache JSON
  # to embed-cache/marengo/. StartAsyncInvoke writes its output to
  # async-out-eval/ which the agent then reads.
  statement {
    sid     = "MarengoAsyncInvokeIO"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.clips.arn}/async-in-eval/*",
      "${aws_s3_bucket.clips.arn}/async-out-eval/*",
      "${aws_s3_bucket.clips.arn}/embed-cache/*",
    ]
  }
  statement {
    sid     = "MarengoAsyncInvoke"
    actions = ["bedrock:InvokeModel", "bedrock:StartAsyncInvoke", "bedrock:GetAsyncInvoke"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/twelvelabs.marengo-embed-3-0-v1:0",
      # Bedrock returns InvokeModel-denied on the async-invoke resource
      # (not the foundation-model) during the intermediate output-
      # composition step. Without this second ARN the Marengo fallback
      # in find_by_image blows up as soon as the async job completes.
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:async-invoke/*",
    ]
  }
  # v0.4 hybrid entity-reID: query per-KS Rekognition face collections.
  statement {
    sid       = "RekognitionSearch"
    actions   = ["rekognition:SearchFacesByImage", "rekognition:DescribeCollection"]
    resources = ["arn:aws:rekognition:${var.region}:${data.aws_caller_identity.current.account_id}:collection/${local.fqname}-ks-*"]
  }
  # Rekognition Video SegmentDetection powers the get_shot_timeline agent
  # tool. StartSegmentDetection + GetSegmentDetection operate on the account
  # level — no collection scoping — so resource is "*". The video S3 object
  # is accessed via the Rekognition service principal, not the runtime
  # role, so no extra s3:GetObject grant is required beyond the existing
  # ReadClipBytes statement.
  statement {
    sid     = "RekognitionSegmentDetection"
    actions = [
      "rekognition:StartSegmentDetection",
      "rekognition:GetSegmentDetection",
    ]
    resources = ["*"]
  }
  # Comprehend DetectSentiment + DetectEntities back the get_audio_context
  # tool (transcript-derived audio activity sketch). Account-wide sync APIs
  # with no resource-level scoping.
  statement {
    sid     = "ComprehendDetect"
    actions = [
      "comprehend:DetectSentiment",
      "comprehend:DetectEntities",
    ]
    resources = ["*"]
  }
  # Read the cache DDB tables. kb_cache is Query-driven (single-
  # table pk/sk); rights and audiences are GetItem + Scan. Write access
  # belongs to the operator (ingest-kb-cache.py + seed-*.py), not the
  # runtime — the runtime only reads.
  statement {
    sid = "ReadCacheTables"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
    ]
    resources = [
      aws_dynamodb_table.kb_cache.arn,
      aws_dynamodb_table.rights.arn,
      aws_dynamodb_table.audiences.arn,
    ]
  }
  # Multi-turn session scratch + per-user long-term memory. The runtime
  # both reads (list/get memories) and writes (persist session turn,
  # save a memory, delete a memory via manage_memory).
  statement {
    sid = "SessionAndMemoryTables"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.sessions.arn,
      aws_dynamodb_table.memories.arn,
    ]
  }
  # PR #8: add_media writes a lightweight registration row (asset_id,
  # knowledge_store_id, source S3 URI, status) to the assets table. The
  # runtime does NOT get write on kb_cache or on the vector index — those
  # stay operator-owned. GetItem lets add_media no-op on a duplicate, if we
  # add that path later.
  statement {
    sid       = "AddMediaWriteAssets"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.assets.arn]
  }
  # PR #10: mining plans. The jockey_save / jockey_list / jockey_run /
  # jockey_list_runs agent tools need:
  #   - full RW on the plans table (save creates, delete pauses, list queries)
  #   - Query on the plans by-ks GSI (list filtered by knowledge_store_id)
  #   - Read on the runs table (jockey_list_runs is a per-plan Query)
  #   - EventBridge Scheduler C/U/D scoped to our mining group
  #   - lambda:InvokeFunction on the mining-run Lambda (jockey_run sync path)
  #   - iam:PassRole on the scheduler-target role, so scheduler:CreateSchedule
  #     can hand that role to EventBridge when it creates a per-plan Schedule
  statement {
    sid = "MiningPlansDdb"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = [
      aws_dynamodb_table.jockey_plans.arn,
      "${aws_dynamodb_table.jockey_plans.arn}/index/by-ks",
      aws_dynamodb_table.jockey_runs.arn,
    ]
  }
  statement {
    sid = "MiningScheduler"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:UpdateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
    ]
    resources = [
      "arn:aws:scheduler:${var.region}:${data.aws_caller_identity.current.account_id}:schedule/${aws_scheduler_schedule_group.mining.name}/*",
    ]
  }
  statement {
    sid     = "MiningRunInvoke"
    actions = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.mining_run.arn]
  }
  statement {
    sid     = "MiningSchedulerPassRole"
    actions = ["iam:PassRole"]
    resources = [aws_iam_role.mining_scheduler_target.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "runtime" {
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime_perms.json
}
