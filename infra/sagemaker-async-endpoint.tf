# Phase 3-proper: SageMaker Async Inference endpoint for gdino.
#
# Originally designed against Processing Jobs (see git history) but
# rolled back when we discovered the account's ml.g6.xlarge processing-job
# quota was 0 in spite of Service Quotas reporting 2. Endpoint quotas are
# provisioned (ml.g5.xlarge: 4), so we deploy the same container as a
# SageMaker Async Inference endpoint:
#
#   - Same gdino image (Step 1 lift + SageMaker BYOC /ping + /invocations)
#   - Async invocation: enqueue input JSON to S3, get a future S3 output URI,
#     poll until output appears. Matches the prior orchestration shape.
#   - Autoscale-to-zero: min_capacity=0 (true serverless economics).
#     When the queue is empty for ~15 min the endpoint scales down; on
#     enqueue it spins back up (cold start ~5-10 min for TRT engine build
#     on first request after scale-up).
#
# Files in this terraform module:
#   1. ECR repo + lifecycle policy (gdino image)
#   2. CodeBuild project that builds the image (linux/amd64)
#   3. SageMaker Model + EndpointConfig + Endpoint (+IAM)
#   4. Application Auto-Scaling target/policy for scale-to-zero
#   5. S3 Vectors index `entity-patches` (1024-dim Titan space)

# ─── ECR repository for the gdino expert-model container ──────────────────
resource "aws_ecr_repository" "gdino" {
  name                 = "${local.fqname}-gdino"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }
}

resource "aws_ecr_lifecycle_policy" "gdino" {
  repository = aws_ecr_repository.gdino.name
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

# ─── S3 prefix layout for async invocations ───────────────────────────────
# Inputs:   s3://<clips>/async/<exec-id>/<asset_id>/in.json
# Outputs:  s3://<clips>/async/<exec-id>/<asset_id>/out.json (when ready)
# Failures: s3://<clips>/async-fail/<exec-id>/<asset_id>.err
#
# All under the existing clips bucket — no new bucket needed. The endpoint's
# execution role grants read+write on async/ + async-fail/ only.

# ─── SageMaker Endpoint execution role ────────────────────────────────────
data "aws_iam_policy_document" "sagemaker_endpoint_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["sagemaker.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sagemaker_endpoint" {
  name               = "${local.fqname}-sagemaker-endpoint"
  assume_role_policy = data.aws_iam_policy_document.sagemaker_endpoint_assume.json
}

data "aws_iam_policy_document" "sagemaker_endpoint_perms" {
  statement {
    sid = "AsyncIOAccess"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.clips.arn,
      "${aws_s3_bucket.clips.arn}/*",
    ]
  }

  # Pull the gdino image at endpoint provisioning.
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

  statement {
    sid = "Cloudwatch"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
      "cloudwatch:PutMetricData",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "sagemaker_endpoint" {
  role   = aws_iam_role.sagemaker_endpoint.id
  policy = data.aws_iam_policy_document.sagemaker_endpoint_perms.json
}

# ─── SageMaker Model + EndpointConfig + Endpoint ──────────────────────────
# The image URI is read from var.gdino_image_tag (declared in
# step-functions.tf as well; same var). Default `latest` — pin per build
# for reproducibility.

# AWS provider <7 doesn't expose name_prefix on aws_sagemaker_model or
# aws_sagemaker_endpoint_configuration. Both resources have immutable
# names — any image_tag change forces destroy+create, and with
# create_before_destroy + a fixed name we'd collide with the doomed
# resource. The random_id below regenerates on every image_tag change
# and gets appended into both names so create_before_destroy works.
locals {
  # Container env vars passed into the SageMaker Model resource. Lower the
  # HF GDINO thresholds vs. the in-code defaults (0.20) — for 360p test
  # footage 0.10 / 0.15 give reasonable recall. Tune per-deployment.
  gdino_container_env = {
    HF_BOX_THRESHOLD  = "0.10"
    HF_TEXT_THRESHOLD = "0.15"
  }
}

resource "random_id" "gdino_revision" {
  byte_length = 4
  keepers = {
    image_tag = var.gdino_image_tag
    # Regen when env vars change too — Model is immutable so any container
    # env change forces destroy+create, and with create_before_destroy +
    # a name that doesn't move we hit "Cannot create already existing model".
    env_hash = md5(jsonencode(local.gdino_container_env))
  }
}

resource "aws_sagemaker_model" "gdino" {
  name               = "${local.fqname}-gdino-${random_id.gdino_revision.hex}"
  execution_role_arn = aws_iam_role.sagemaker_endpoint.arn

  primary_container {
    image       = "${aws_ecr_repository.gdino.repository_url}:${var.gdino_image_tag}"
    environment = local.gdino_container_env
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_sagemaker_endpoint_configuration" "gdino_async" {
  name = "${local.fqname}-gdino-async-${random_id.gdino_revision.hex}"

  production_variants {
    variant_name           = "AllTraffic"
    model_name             = aws_sagemaker_model.gdino.name
    initial_instance_count = 1
    instance_type          = "ml.g5.xlarge" # endpoint quota = 4 in this account

    # start.sh does the TRT engine build (~5-10 min on g5.xlarge) BEFORE
    # exec'ing uvicorn — meaning /ping isn't reachable during the cold
    # start. SageMaker's default ping-health-check timeout is short and
    # kills the variant before uvicorn ever comes up. Lifting it to the
    # max (3600s) lets the cold-start path actually complete.
    container_startup_health_check_timeout_in_seconds = 3600
  }

  async_inference_config {
    output_config {
      s3_output_path  = "s3://${aws_s3_bucket.clips.bucket}/async-out/"
      s3_failure_path = "s3://${aws_s3_bucket.clips.bucket}/async-fail/"
    }
    client_config {
      # gdino /invocations is single-flight per process (a Semaphore inside
      # service/server.py caps to MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES).
      # Match that here so SageMaker doesn't queue inside the container.
      max_concurrent_invocations_per_instance = 1
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_sagemaker_endpoint" "gdino" {
  name                 = "${local.fqname}-gdino"
  endpoint_config_name = aws_sagemaker_endpoint_configuration.gdino_async.name
}

# ─── Scale-to-zero ────────────────────────────────────────────────────────
# Target-tracking on SageMaker's ApproximateBacklogSizePerInstance metric.
# Queue grows → scale out; queue empties → scale back to 0.
resource "aws_appautoscaling_target" "gdino_endpoint" {
  service_namespace  = "sagemaker"
  scalable_dimension = "sagemaker:variant:DesiredInstanceCount"
  resource_id        = "endpoint/${aws_sagemaker_endpoint.gdino.name}/variant/AllTraffic"
  min_capacity       = 0
  max_capacity       = 2 # leaves headroom inside our quota of 4 for ad-hoc
}

resource "aws_appautoscaling_policy" "gdino_endpoint_scale_out" {
  name               = "${local.fqname}-gdino-scale-on-backlog"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.gdino_endpoint.service_namespace
  scalable_dimension = aws_appautoscaling_target.gdino_endpoint.scalable_dimension
  resource_id        = aws_appautoscaling_target.gdino_endpoint.resource_id

  target_tracking_scaling_policy_configuration {
    target_value = 1.0 # one queued job per instance — aggressive scale-out

    customized_metric_specification {
      metric_name = "ApproximateBacklogSizePerInstance"
      namespace   = "AWS/SageMaker"
      statistic   = "Average"
      dimensions {
        name  = "EndpointName"
        value = aws_sagemaker_endpoint.gdino.name
      }
    }

    scale_in_cooldown  = 600 # wait 10 min after queue empties before scaling down
    scale_out_cooldown = 60  # but scale out fast — cold start is already ~10 min
  }
}

# ─── S3 Vectors index: entity-patches (1024-dim Titan space) ──────────────
resource "aws_s3vectors_index" "entity_patches" {
  vector_bucket_name = aws_s3vectors_vector_bucket.clips.vector_bucket_name
  index_name         = "entity-patches"
  data_type          = "float32"
  dimension          = 1024
  distance_metric    = "cosine"
}

# ─── CodeBuild project: builds the gdino image on linux/amd64 ─────────────
data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild_gdino" {
  name               = "${local.fqname}-codebuild-gdino"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

data "aws_iam_policy_document" "codebuild_gdino_perms" {
  statement {
    sid       = "Cloudwatch"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadSource"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn, "${aws_s3_bucket.clips.arn}/*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "codebuild_gdino" {
  role   = aws_iam_role.codebuild_gdino.id
  policy = data.aws_iam_policy_document.codebuild_gdino_perms.json
}

resource "aws_codebuild_project" "gdino" {
  name          = "${local.fqname}-build-gdino"
  description   = "Build the GDINO Triton expert-model container and push to ECR."
  build_timeout = 60
  service_role  = aws_iam_role.codebuild_gdino.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_LARGE"
    image           = "aws/codebuild/standard:7.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = true

    environment_variable {
      name  = "AWS_REGION"
      value = var.region
    }
    environment_variable {
      name  = "ECR_REPO"
      value = aws_ecr_repository.gdino.repository_url
    }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.clips.bucket}/codebuild-src/gdino.zip"
    buildspec = "agent/expert-models/gdino/buildspec.yaml"
  }

  logs_config {
    cloudwatch_logs {
      group_name = "/aws/codebuild/${local.fqname}-build-gdino"
    }
  }
}
