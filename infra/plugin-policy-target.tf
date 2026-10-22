# Reference AgentCore Gateway Lambda target: distribution policy.
#
# Owns a NEW table (plugin_policies) because the stack had nowhere
# else to store the per-territory required-deliverables list. Seeded
# in Terraform with a few reasonable defaults so the demo lights up
# with no manual data loading — customers overwrite rows or swap this
# whole plugin for one that hits their own compliance system.

# ─── DDB table + seed data ────────────────────────────────────────────
resource "aws_dynamodb_table" "plugin_policies" {
  name         = "${local.fqname}-plugin-policies"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "territory"

  point_in_time_recovery { enabled = true }

  attribute {
    name = "territory"
    type = "S"
  }
}

# Seed rows. territory = ISO/short code (uppercase), or "DEFAULT" for
# the fallback. Each row's `required` is the baseline deliverable list;
# `by_asset_type.<type>` can add type-specific extras. Deliverable
# labels follow the asset-registry convention (video, poster, trailer,
# subs:<locale>, audio_desc, etc.).
resource "aws_dynamodb_table_item" "plugin_policy_default" {
  table_name = aws_dynamodb_table.plugin_policies.name
  hash_key   = aws_dynamodb_table.plugin_policies.hash_key
  item = jsonencode({
    territory = { S = "DEFAULT" }
    required  = { L = [{ S = "video" }, { S = "poster" }] }
    notes     = { S = "Baseline — every territory needs at least the master video + poster art." }
  })
}

resource "aws_dynamodb_table_item" "plugin_policy_de" {
  table_name = aws_dynamodb_table.plugin_policies.name
  hash_key   = aws_dynamodb_table.plugin_policies.hash_key
  item = jsonencode({
    territory = { S = "DE" }
    required  = { L = [
      { S = "video" }, { S = "poster" }, { S = "subs:de" }, { S = "trailer" }
    ] }
    by_asset_type = { M = {
      series = { L = [{ S = "episode_art" }] }
    } }
    notes = { S = "Germany: German subs + trailer are table-stakes; series also need per-episode art." }
  })
}

resource "aws_dynamodb_table_item" "plugin_policy_jp" {
  table_name = aws_dynamodb_table.plugin_policies.name
  hash_key   = aws_dynamodb_table.plugin_policies.hash_key
  item = jsonencode({
    territory = { S = "JP" }
    required  = { L = [
      { S = "video" }, { S = "poster" }, { S = "subs:ja" }, { S = "audio_desc:ja" }, { S = "trailer" }
    ] }
    notes = { S = "Japan: subs + audio description + trailer required." }
  })
}

resource "aws_dynamodb_table_item" "plugin_policy_br" {
  table_name = aws_dynamodb_table.plugin_policies.name
  hash_key   = aws_dynamodb_table.plugin_policies.hash_key
  item = jsonencode({
    territory = { S = "BR" }
    required  = { L = [
      { S = "video" }, { S = "poster" }, { S = "subs:pt-br" }, { S = "trailer" }
    ] }
    notes = { S = "Brazil: pt-BR subs expected (not pt-PT)." }
  })
}

# ─── Lambda ───────────────────────────────────────────────────────────
locals {
  plugin_policy_root = "${path.module}/../lambda/plugin_policy"
}

data "archive_file" "plugin_policy" {
  type        = "zip"
  source_dir  = local.plugin_policy_root
  output_path = "${path.module}/.build/plugin_policy.zip"
}

resource "aws_iam_role" "plugin_policy" {
  name               = "${local.fqname}-plugin-policy"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "plugin_policy_basic" {
  role       = aws_iam_role.plugin_policy.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "plugin_policy_perms" {
  statement {
    sid       = "PoliciesTableRead"
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.plugin_policies.arn]
  }
}

resource "aws_iam_role_policy" "plugin_policy" {
  role   = aws_iam_role.plugin_policy.id
  policy = data.aws_iam_policy_document.plugin_policy_perms.json
}

resource "aws_lambda_function" "plugin_policy" {
  function_name    = "${local.fqname}-plugin-policy"
  role             = aws_iam_role.plugin_policy.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.plugin_policy.output_path
  source_code_hash = data.archive_file.plugin_policy.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      POLICIES_TABLE = aws_dynamodb_table.plugin_policies.name
    }
  }
}

resource "aws_cloudwatch_log_group" "plugin_policy" {
  name              = "/aws/lambda/${aws_lambda_function.plugin_policy.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "gateway_invoke_plugin_policy" {
  statement_id  = "AllowGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.plugin_policy.function_name
  principal     = "bedrock-agentcore.amazonaws.com"
  source_arn    = aws_bedrockagentcore_gateway.plugins.gateway_arn
}

resource "aws_bedrockagentcore_gateway_target" "plugin_policy" {
  gateway_identifier = aws_bedrockagentcore_gateway.plugins.gateway_id
  name               = "plugin-policy"
  description        = "Distribution policy — the 'what artifacts does Germany need before I can ship there?' lookup."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.plugin_policy.arn

        tool_schema {
          inline_payload {
            name        = "requirements_for"
            description = "Return the required deliverable artifacts for distributing an asset to the given territory. Pair with the asset's registered deliverables to compute the gap list ('you have video + poster but are missing subs:de and trailer')."

            input_schema {
              type = "object"
              property {
                name        = "territory"
                type        = "string"
                description = "Target territory code (e.g. 'DE', 'JP', 'US')."
              }
              property {
                name        = "asset_type"
                type        = "string"
                description = "Optional asset classification (film / series / episode) — overlays type-specific extras."
              }
            }

            output_schema {
              type = "object"
              property {
                name        = "requirements"
                type        = "array"
                description = "Deliverable labels needed before distribution (video, poster, subs:de, trailer, etc.)."
              }
              property {
                name        = "applied_policy"
                type        = "string"
                description = "Which policy row was used — the exact territory or DEFAULT."
              }
              property {
                name        = "notes"
                type        = "string"
                description = "Optional operator notes attached to this policy row."
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_lambda_permission.gateway_invoke_plugin_policy]
}
