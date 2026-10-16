# Mining plans (PR #10 of Jockey parity).
#
# ─── Resources owned here ──────────────────────────────────────────────────
#   mining-run Lambda       Python 3.12. Reads a jockey_plans row + invokes
#                           the AgentCore runtime + writes a jockey_runs row.
#                           Triggered by EventBridge Scheduler (one Schedule
#                           per plan, created at runtime by the agent's
#                           `jockey_save` tool) OR synchronously by the
#                           runtime via `jockey_run`.
#   Scheduler group         Namespace for all per-plan Schedules so cleanup
#                           and listing stay contained.
#   Scheduler → Lambda role Role EventBridge Scheduler assumes to invoke the
#                           Lambda. Separate from the Lambda's own execution
#                           role.
#
# ─── NOT owned here ────────────────────────────────────────────────────────
# Per-plan Schedules themselves — those are created at agent-run time by
# `jockey_save` via scheduler:CreateSchedule, so operators can save plans
# without a terraform apply loop. The scheduler-group below is the stable
# container they live in.

locals {
  mining_run_root = "${path.module}/../lambda/mining_run"
}

data "archive_file" "mining_run" {
  type        = "zip"
  source_dir  = local.mining_run_root
  output_path = "${path.module}/.build/mining_run.zip"
}

# ─── Lambda execution role ────────────────────────────────────────────────
resource "aws_iam_role" "mining_run" {
  name               = "${local.fqname}-mining-run"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "mining_run_basic" {
  role       = aws_iam_role.mining_run.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "mining_run_perms" {
  # Read the plan + write the run row.
  statement {
    sid = "MiningDdb"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = [
      aws_dynamodb_table.jockey_plans.arn,
      aws_dynamodb_table.jockey_runs.arn,
    ]
  }
  # Invoke the AgentCore runtime. SigV4-signed by the role.
  statement {
    sid       = "InvokeAgentRuntime"
    actions   = ["bedrock-agentcore:InvokeAgentRuntime"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "mining_run" {
  role   = aws_iam_role.mining_run.id
  policy = data.aws_iam_policy_document.mining_run_perms.json
}

# ─── The Lambda itself ────────────────────────────────────────────────────
resource "aws_lambda_function" "mining_run" {
  function_name    = "${local.fqname}-mining-run"
  role             = aws_iam_role.mining_run.arn
  runtime          = "python3.12"
  handler          = "handler.handler"
  filename         = data.archive_file.mining_run.output_path
  source_code_hash = data.archive_file.mining_run.output_base64sha256
  timeout          = 300  # 5 min — a mining run may wait on Pegasus
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      JOCKEY_PLANS_TABLE = aws_dynamodb_table.jockey_plans.name
      JOCKEY_RUNS_TABLE  = aws_dynamodb_table.jockey_runs.name
      # Two-stage apply (see variable "agent_runtime_arn" in variables.tf):
      # empty on first apply (runtime hasn't been created yet) → mining-run
      # fails fast with a clear error; on second apply the operator passes
      # the ARN via -var and the Lambda is live.
      AGENT_RUNTIME_ARN = var.agent_runtime_arn
    }
  }
}

resource "aws_cloudwatch_log_group" "mining_run" {
  name              = "/aws/lambda/${aws_lambda_function.mining_run.function_name}"
  retention_in_days = 14
}

# ─── EventBridge Scheduler ────────────────────────────────────────────────
#
# One group holds every per-plan Schedule the agent creates. The scheduler
# service assumes `mining_scheduler_target` to invoke the Lambda; we keep that
# role strictly scoped to lambda:InvokeFunction on this one function.

resource "aws_scheduler_schedule_group" "mining" {
  name = "${local.fqname}-mining"
}

data "aws_iam_policy_document" "mining_scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    # Scope to this account to avoid confused-deputy.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "mining_scheduler_target" {
  name               = "${local.fqname}-mining-scheduler-target"
  assume_role_policy = data.aws_iam_policy_document.mining_scheduler_assume.json
}

data "aws_iam_policy_document" "mining_scheduler_target_perms" {
  statement {
    sid       = "InvokeMiningRunLambda"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.mining_run.arn]
  }
}

resource "aws_iam_role_policy" "mining_scheduler_target" {
  role   = aws_iam_role.mining_scheduler_target.id
  policy = data.aws_iam_policy_document.mining_scheduler_target_perms.json
}

# ─── Outputs the agent tools need ─────────────────────────────────────────
# These flow through runtime.tf env vars so the agent's jockey_save tool
# can create Schedules in the right group with the right target role.
output "mining_scheduler_group_name" {
  value = aws_scheduler_schedule_group.mining.name
}
output "mining_scheduler_target_role_arn" {
  value = aws_iam_role.mining_scheduler_target.arn
}
output "mining_run_lambda_arn" {
  value = aws_lambda_function.mining_run.arn
}
