# Rekognition Faces — replaces the bespoke gdino+Titan stack.
#
# Collections are PER-KS, lazy-created by the index_faces lambda on first
# call. Collection id convention: `<fqname>-ks-<ks_id>`. The agent's
# find_by_image tool derives the collection id from its knowledge_store_id
# argument; no DDB join needed.
#
# Auto-trigger wiring (EventBridge rule on hls_finalize completion) lands
# in v0.4 step 4. For step 1 the lambda is invoked manually or by
# scripts/backfill_rekognition.py.

locals {
  index_faces_root = "${path.module}/../lambda/index_faces"
}

data "archive_file" "index_faces" {
  type        = "zip"
  source_dir  = local.index_faces_root
  output_path = "${path.module}/.build/index_faces.zip"
}

resource "aws_iam_role" "index_faces" {
  name               = "${local.fqname}-index-faces"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "index_faces_basic" {
  role       = aws_iam_role.index_faces.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "index_faces_perms" {
  statement {
    sid = "RekognitionCollections"
    actions = [
      "rekognition:CreateCollection",
      "rekognition:IndexFaces",
      "rekognition:ListCollections",
      "rekognition:DescribeCollection",
    ]
    # IndexFaces / CreateCollection target ARNs are wildcard-scoped
    # per the per-KS collection_id pattern (`<fqname>-ks-<ks_id>`).
    resources = ["arn:aws:rekognition:${var.region}:${data.aws_caller_identity.current.account_id}:collection/${local.fqname}-ks-*"]
  }
  statement {
    # RecognizeCelebrities isn't tied to a collection — needs * resource.
    sid       = "RekognitionCelebrities"
    actions   = ["rekognition:RecognizeCelebrities"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadThumbFrames"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.clips.arn, "${aws_s3_bucket.clips.arn}/hls/*"]
  }
  statement {
    sid       = "PersistFaceCountAndCelebrities"
    actions   = ["dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.assets.arn]
  }
}

resource "aws_iam_role_policy" "index_faces" {
  role   = aws_iam_role.index_faces.id
  policy = data.aws_iam_policy_document.index_faces_perms.json
}

resource "aws_lambda_function" "index_faces" {
  function_name    = "${local.fqname}-index-faces"
  role             = aws_iam_role.index_faces.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.index_faces.output_path
  source_code_hash = data.archive_file.index_faces.output_base64sha256
  # Backfill mode (asset_ids batch) needs headroom: 4 frames/asset × ~1 s
  # per IndexFaces call. 300 assets ≈ 20 min; lambda max is 15 min, so
  # the backfill script chunks into batches of ≤50 assets per invoke.
  timeout     = 900
  memory_size = 512

  tracing_config { mode = "Active" }

  environment {
    variables = {
      STACK_FQNAME         = local.fqname
      CLIPS_BUCKET_NAME    = aws_s3_bucket.clips.bucket
      ASSETS_TABLE         = aws_dynamodb_table.assets.name
      FRAMES_PER_ASSET     = "4"
      MIN_CELEB_CONFIDENCE = "85.0"
    }
  }
}

resource "aws_cloudwatch_log_group" "index_faces" {
  name              = "/aws/lambda/${aws_lambda_function.index_faces.function_name}"
  retention_in_days = 14
}

output "index_faces_lambda_arn" {
  value       = aws_lambda_function.index_faces.arn
  description = "Invoke directly for ad-hoc / backfill ingest. Auto-trigger wired in v0.4 step 4."
}
