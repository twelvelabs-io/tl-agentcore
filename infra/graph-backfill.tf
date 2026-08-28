# graph_backfill — one-shot job that rebuilds the graph from kb_cache +
# rights DDB rows. Fires on every apply where the graph id or backfill
# code hash changes.
#
# Why a null_resource + local-exec instead of aws_lambda_invocation:
#   - aws_lambda_invocation is InvocationType=RequestResponse and blocks
#     the apply for the full duration. On a fresh stack with many KSes
#     this can be 20+ min.
#   - local-exec fires InvocationType=Event so the apply returns while
#     the backfill runs asynchronously in the background. CloudWatch
#     logs (/aws/lambda/<name>-graph-backfill) carry the outcome.

locals {
  graph_backfill_root = "${path.module}/../lambda/graph_backfill"
}

data "archive_file" "graph_backfill" {
  type        = "zip"
  source_dir  = local.graph_backfill_root
  output_path = "${path.module}/.build/graph_backfill.zip"
}

resource "aws_iam_role" "graph_backfill" {
  name               = "${local.fqname}-graph-backfill"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "graph_backfill_basic" {
  role       = aws_iam_role.graph_backfill.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "graph_backfill_perms" {
  # Scan every KS to know which ones to roll up. Scan the assets table
  # to build the asset_id → ks_id map used when writing Rights edges.
  # Scan the rights table to source the Rights nodes themselves.
  statement {
    sid     = "ScanTables"
    actions = ["dynamodb:Scan"]
    resources = [
      aws_dynamodb_table.knowledge_stores.arn,
      aws_dynamodb_table.assets.arn,
      aws_dynamodb_table.rights.arn,
    ]
  }
  # Invoke ks_rollup once per KS (RequestResponse so we can log the
  # result payload). Scoped to the specific rollup ARN.
  statement {
    sid       = "InvokeKsRollup"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.ks_rollup.arn]
  }
  # Write Rights nodes + COVERS edges directly.
  statement {
    sid       = "GraphWrite"
    actions   = ["neptune-graph:ReadDataViaQuery", "neptune-graph:WriteDataViaQuery", "neptune-graph:DeleteDataViaQuery"]
    resources = [aws_neptunegraph_graph.this.arn]
  }
}

resource "aws_iam_role_policy" "graph_backfill" {
  role   = aws_iam_role.graph_backfill.id
  policy = data.aws_iam_policy_document.graph_backfill_perms.json
}

resource "aws_lambda_function" "graph_backfill" {
  function_name    = "${local.fqname}-graph-backfill"
  role             = aws_iam_role.graph_backfill.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.graph_backfill.output_path
  source_code_hash = data.archive_file.graph_backfill.output_base64sha256
  # Scales with the number of KSes × avg rollup time. 15 min hard cap
  # on Lambda; a stack with more than ~90 KSes at ~10s each needs
  # sharding — worry about that when it happens.
  timeout     = 900
  memory_size = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      KS_TABLE      = aws_dynamodb_table.knowledge_stores.name
      ASSETS_TABLE  = aws_dynamodb_table.assets.name
      RIGHTS_TABLE  = aws_dynamodb_table.rights.name
      KS_ROLLUP_ARN = aws_lambda_function.ks_rollup.arn
      GRAPH_ID      = aws_neptunegraph_graph.this.id
    }
  }
}

resource "aws_cloudwatch_log_group" "graph_backfill" {
  name              = "/aws/lambda/${aws_lambda_function.graph_backfill.function_name}"
  retention_in_days = 14
}

# Fires on every apply where the graph identifier changes (the graph
# was just created) OR the backfill code hash changes. Runs
# InvocationType=Event so apply doesn't wait for the (potentially long)
# backfill; watch the log group for progress.
resource "null_resource" "graph_backfill_trigger" {
  triggers = {
    graph_id  = aws_neptunegraph_graph.this.id
    code_hash = data.archive_file.graph_backfill.output_base64sha256
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws lambda invoke \
        --function-name ${aws_lambda_function.graph_backfill.function_name} \
        --invocation-type Event \
        --region ${var.region} \
        ${var.aws_profile != "" ? "--profile ${var.aws_profile}" : ""} \
        /dev/null
    EOT
  }

  depends_on = [
    aws_lambda_function.graph_backfill,
    aws_neptunegraph_graph.this,
  ]
}
