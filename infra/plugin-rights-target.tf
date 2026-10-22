# Reference AgentCore Gateway Lambda target: rights management.
#
# Replaces the in-process lookup_rights tool and adds list_cleared_assets
# (the "every asset I can ship to Germany next week" inverted query).
# Reads the same RIGHTS_TABLE as the in-proc version did.

locals {
  plugin_rights_root = "${path.module}/../lambda/plugin_rights"
}

data "archive_file" "plugin_rights" {
  type        = "zip"
  source_dir  = local.plugin_rights_root
  output_path = "${path.module}/.build/plugin_rights.zip"
}

resource "aws_iam_role" "plugin_rights" {
  name               = "${local.fqname}-plugin-rights"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "plugin_rights_basic" {
  role       = aws_iam_role.plugin_rights.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "plugin_rights_perms" {
  statement {
    sid       = "RightsTableRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.rights.arn]
  }
}

resource "aws_iam_role_policy" "plugin_rights" {
  role   = aws_iam_role.plugin_rights.id
  policy = data.aws_iam_policy_document.plugin_rights_perms.json
}

resource "aws_lambda_function" "plugin_rights" {
  function_name    = "${local.fqname}-plugin-rights"
  role             = aws_iam_role.plugin_rights.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.plugin_rights.output_path
  source_code_hash = data.archive_file.plugin_rights.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      RIGHTS_TABLE = aws_dynamodb_table.rights.name
    }
  }
}

resource "aws_cloudwatch_log_group" "plugin_rights" {
  name              = "/aws/lambda/${aws_lambda_function.plugin_rights.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "gateway_invoke_plugin_rights" {
  statement_id  = "AllowGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.plugin_rights.function_name
  principal     = "bedrock-agentcore.amazonaws.com"
  source_arn    = aws_bedrockagentcore_gateway.plugins.gateway_arn
}

resource "aws_bedrockagentcore_gateway_target" "plugin_rights" {
  gateway_identifier = aws_bedrockagentcore_gateway.plugins.gateway_id
  name               = "plugin-rights"
  description        = "Rights management — per-asset licensing windows + inverted territory→cleared-assets query."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.plugin_rights.arn

        # Tool 1 — lookup_rights
        tool_schema {
          inline_payload {
            name        = "lookup_rights"
            description = "Fetch licensing + clearance for one asset. Use whenever the user asks about usage rights, territory, license windows/expiry, talent clearance, or 'can we use this'."

            input_schema {
              type = "object"
              property {
                name        = "asset_id"
                type        = "string"
                description = "The asset id — resolved via prior tools, never guessed."
              }
              property {
                name        = "region"
                type        = "string"
                description = "Optional region filter (US, EMEA, APAC, GLOBAL)."
              }
            }

            output_schema {
              type = "object"
              property {
                name        = "found"
                type        = "boolean"
                description = "Whether the rights record existed."
              }
              property {
                name        = "rights"
                type        = "array"
                description = "Licensing windows: territory, window_start, window_end, usage_type."
              }
              property {
                name        = "talent_clearances"
                type        = "array"
                description = "Per-talent clearance records."
              }
            }
          }

          # Tool 2 — list_cleared_assets (NEW)
          inline_payload {
            name        = "list_cleared_assets"
            description = "List every asset whose rights windows include the given territory on `as_of` (defaults to now). The 'what can I ship to Germany next week' inverted query."

            input_schema {
              type = "object"
              property {
                name        = "territory"
                type        = "string"
                description = "Target territory code."
              }
              property {
                name        = "as_of"
                type        = "string"
                description = "Optional ISO-8601 timestamp to check against. Defaults to current time."
              }
            }

            output_schema {
              type = "object"
              property {
                name        = "count"
                type        = "integer"
                description = "Number of cleared assets."
              }
              property {
                name        = "assets"
                type        = "array"
                description = "Each with asset_id, title, matching windows."
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_lambda_permission.gateway_invoke_plugin_rights]
}
