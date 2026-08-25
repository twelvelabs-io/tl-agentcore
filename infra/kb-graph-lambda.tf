# kb_graph lambda — reads the Phase 1/2/4 knowledge-graph records from
# kb_cache DDB (OVERVIEW + ASSET# + ENTITY# + EVENT#) and returns the
# {nodes, edges} payload the UI's Graph tab renders via React Flow.
#
# Browser → CloudFront `/kb-graph` → HTTP API Gateway → this lambda → DDB.

locals {
  kb_graph_root = "${path.module}/../lambda/kb_graph"
}

data "archive_file" "kb_graph" {
  type        = "zip"
  source_dir  = local.kb_graph_root
  output_path = "${path.module}/.build/kb_graph.zip"
}

data "aws_iam_policy_document" "kb_graph_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "kb_graph" {
  name               = "${local.fqname}-kb-graph"
  assume_role_policy = data.aws_iam_policy_document.kb_graph_assume.json
}

resource "aws_iam_role_policy_attachment" "kb_graph_basic" {
  role       = aws_iam_role.kb_graph.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "kb_graph_perms" {
  # Overview row is still read from kb_cache (kept as the single source
  # of truth for the corpus digest). Nodes + edges come from the graph.
  statement {
    sid       = "ReadOverviewRow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.kb_cache.arn]
  }
  # Read the KS row to enforce per-user ownership before serving the graph.
  statement {
    sid       = "ReadKsRow"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.knowledge_stores.arn]
  }
  # Read-only Neptune Analytics access — the graph render is a straight
  # projection; kb_graph never writes.
  statement {
    sid       = "GraphRead"
    actions   = ["neptune-graph:ReadDataViaQuery"]
    resources = [aws_neptunegraph_graph.this.arn]
  }
}

resource "aws_iam_role_policy" "kb_graph" {
  role   = aws_iam_role.kb_graph.id
  policy = data.aws_iam_policy_document.kb_graph_perms.json
}

resource "aws_lambda_function" "kb_graph" {
  function_name    = "${local.fqname}-kb-graph"
  role             = aws_iam_role.kb_graph.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.kb_graph.output_path
  source_code_hash = data.archive_file.kb_graph.output_base64sha256
  timeout          = 30
  memory_size      = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      KB_CACHE_TABLE       = aws_dynamodb_table.kb_cache.name
      KS_TABLE             = aws_dynamodb_table.knowledge_stores.name
      GRAPH_ID             = aws_neptunegraph_graph.this.id
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.this.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.spa.id
      ADMIN_GROUP_NAME     = aws_cognito_user_group.admins.name
    }
  }
}

resource "aws_cloudwatch_log_group" "kb_graph" {
  name              = "/aws/lambda/${aws_lambda_function.kb_graph.function_name}"
  retention_in_days = 14
}

# ─── HTTP API route /kb-graph → kb_graph lambda ──────────────────────────
resource "aws_apigatewayv2_integration" "kb_graph" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.kb_graph.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "kb_graph_get" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /kb-graph"
  target    = "integrations/${aws_apigatewayv2_integration.kb_graph.id}"
}

resource "aws_apigatewayv2_route" "kb_graph_options" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "OPTIONS /kb-graph"
  target    = "integrations/${aws_apigatewayv2_integration.kb_graph.id}"
}

resource "aws_lambda_permission" "http_invoke_kb_graph" {
  statement_id  = "AllowHttpInvokeKbGraph"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.kb_graph.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
