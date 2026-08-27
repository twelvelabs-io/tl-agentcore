# Enrichment pipeline: Transcribe + Comprehend on the audio track.
#
#   enrich_transcribe_start  — async-invoked by asset_profile after the
#                              ASSET# row is written. Calls
#                              StartTranscriptionJob on the asset mp4
#                              and returns; Transcribe streams the JSON
#                              to s3://<clips>/transcripts/<asset_id>/
#                              on completion.
#   enrich_comprehend        — S3-triggered on transcript landing. Runs
#                              Comprehend DetectEntities, writes
#                              MENTIONED_IN edges to the graph, persists
#                              mentioned_entities[] to the assets row.

# ─── enrich_transcribe_start ───────────────────────────────────────────
locals {
  enrich_transcribe_start_root = "${path.module}/../lambda/enrich_transcribe_start"
}

data "archive_file" "enrich_transcribe_start" {
  type        = "zip"
  source_dir  = local.enrich_transcribe_start_root
  output_path = "${path.module}/.build/enrich_transcribe_start.zip"
}

resource "aws_iam_role" "enrich_transcribe_start" {
  name               = "${local.fqname}-enrich-transcribe-start"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "enrich_transcribe_start_basic" {
  role       = aws_iam_role.enrich_transcribe_start.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "enrich_transcribe_start_perms" {
  statement {
    sid       = "StartTranscribeJob"
    actions   = ["transcribe:StartTranscriptionJob"]
    resources = ["*"]
  }
  # Transcribe assumes the caller's permissions to read the input mp4
  # and to write the output JSON back to the clips bucket.
  statement {
    sid     = "TranscribeReadWriteClips"
    actions = ["s3:GetObject", "s3:PutObject"]
    resources = [
      "${aws_s3_bucket.clips.arn}/clips/*",
      "${aws_s3_bucket.clips.arn}/transcripts/*",
    ]
  }
}

resource "aws_iam_role_policy" "enrich_transcribe_start" {
  role   = aws_iam_role.enrich_transcribe_start.id
  policy = data.aws_iam_policy_document.enrich_transcribe_start_perms.json
}

resource "aws_lambda_function" "enrich_transcribe_start" {
  function_name    = "${local.fqname}-enrich-transcribe-start"
  role             = aws_iam_role.enrich_transcribe_start.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.enrich_transcribe_start.output_path
  source_code_hash = data.archive_file.enrich_transcribe_start.output_base64sha256
  timeout          = 30
  memory_size      = 256

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CLIPS_BUCKET = aws_s3_bucket.clips.bucket
    }
  }
}

resource "aws_cloudwatch_log_group" "enrich_transcribe_start" {
  name              = "/aws/lambda/${aws_lambda_function.enrich_transcribe_start.function_name}"
  retention_in_days = 14
}

# ─── enrich_comprehend ─────────────────────────────────────────────────
locals {
  enrich_comprehend_root = "${path.module}/../lambda/enrich_comprehend"
}

data "archive_file" "enrich_comprehend" {
  type        = "zip"
  source_dir  = local.enrich_comprehend_root
  output_path = "${path.module}/.build/enrich_comprehend.zip"
}

resource "aws_iam_role" "enrich_comprehend" {
  name               = "${local.fqname}-enrich-comprehend"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "enrich_comprehend_basic" {
  role       = aws_iam_role.enrich_comprehend.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "enrich_comprehend_perms" {
  statement {
    sid       = "ReadTranscript"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.clips.arn}/transcripts/*"]
  }
  statement {
    sid       = "DetectEntities"
    actions   = ["comprehend:DetectEntities"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadWriteAssetsRow"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.assets.arn]
  }
  statement {
    sid       = "GraphMerge"
    actions   = ["neptune-graph:ReadDataViaQuery", "neptune-graph:WriteDataViaQuery", "neptune-graph:DeleteDataViaQuery"]
    resources = [aws_neptunegraph_graph.this.arn]
  }
}

resource "aws_iam_role_policy" "enrich_comprehend" {
  role   = aws_iam_role.enrich_comprehend.id
  policy = data.aws_iam_policy_document.enrich_comprehend_perms.json
}

resource "aws_lambda_function" "enrich_comprehend" {
  function_name    = "${local.fqname}-enrich-comprehend"
  role             = aws_iam_role.enrich_comprehend.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.enrich_comprehend.output_path
  source_code_hash = data.archive_file.enrich_comprehend.output_base64sha256
  # Long transcripts shard into many Comprehend calls; give it room.
  timeout     = 600
  memory_size = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      CLIPS_BUCKET = aws_s3_bucket.clips.bucket
      ASSETS_TABLE = aws_dynamodb_table.assets.name
      GRAPH_ID     = aws_neptunegraph_graph.this.id
    }
  }
}

resource "aws_cloudwatch_log_group" "enrich_comprehend" {
  name              = "/aws/lambda/${aws_lambda_function.enrich_comprehend.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "s3_invoke_enrich_comprehend" {
  statement_id  = "AllowS3InvokeEnrichComprehend"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.enrich_comprehend.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.clips.arn
}
