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
  statement {
    sid = "EcrPull"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchCheckLayerAvailability",
    ]
    resources = ["*"]
  }
  # CloudWatch Logs.
  statement {
    sid = "Cloudwatch"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }
  # Invoke the Bedrock model + the cross-region inference profile.
  statement {
    sid = "BedrockInvoke"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:GetInferenceProfile",
      "bedrock:GetFoundationModel",
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
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
  # Marengo async image-embed (find_by_image fallback): the agent
  # uploads the reference image to async-in-eval/ + an embed-cache JSON
  # to embed-cache/marengo/. StartAsyncInvoke writes its output to
  # async-out-eval/ which the agent then reads.
  statement {
    sid       = "MarengoAsyncInvokeIO"
    actions   = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.clips.arn}/async-in-eval/*",
      "${aws_s3_bucket.clips.arn}/async-out-eval/*",
      "${aws_s3_bucket.clips.arn}/embed-cache/*",
    ]
  }
  statement {
    sid       = "MarengoAsyncInvoke"
    actions   = ["bedrock:InvokeModel", "bedrock:StartAsyncInvoke", "bedrock:GetAsyncInvoke"]
    resources = ["arn:aws:bedrock:*::foundation-model/twelvelabs.marengo-embed-3-0-v1:0"]
  }
  # v0.4 hybrid entity-reID: query per-KS Rekognition face collections.
  statement {
    sid     = "RekognitionSearch"
    actions = ["rekognition:SearchFacesByImage", "rekognition:DescribeCollection"]
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
