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
  #   - Pegasus 1.2 (per-clip video analysis)
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
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.claude-sonnet-4-6*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.twelvelabs.marengo-embed-3-0-v1:0",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.twelvelabs.pegasus-1-2-v1:0",
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
}

resource "aws_iam_role_policy" "runtime" {
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime_perms.json
}
