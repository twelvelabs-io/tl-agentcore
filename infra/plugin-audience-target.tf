# Reference AgentCore Gateway Lambda target: audience / customer-360.
#
# Replaces the in-process list_audiences / lookup_audience tools and
# adds a new territory_fit tool. Reads the same AUDIENCES_TABLE as the
# in-proc version did, so no data migration is needed.

locals {
  plugin_audience_root = "${path.module}/../lambda/plugin_audience"
}

data "archive_file" "plugin_audience" {
  type        = "zip"
  source_dir  = local.plugin_audience_root
  output_path = "${path.module}/.build/plugin_audience.zip"
}

resource "aws_iam_role" "plugin_audience" {
  name               = "${local.fqname}-plugin-audience"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "plugin_audience_basic" {
  role       = aws_iam_role.plugin_audience.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "plugin_audience_perms" {
  statement {
    sid       = "AudiencesTableRead"
    actions   = ["dynamodb:GetItem", "dynamodb:Scan"]
    resources = [aws_dynamodb_table.audiences.arn]
  }
}

resource "aws_iam_role_policy" "plugin_audience" {
  role   = aws_iam_role.plugin_audience.id
  policy = data.aws_iam_policy_document.plugin_audience_perms.json
}

resource "aws_lambda_function" "plugin_audience" {
  function_name    = "${local.fqname}-plugin-audience"
  role             = aws_iam_role.plugin_audience.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.plugin_audience.output_path
  source_code_hash = data.archive_file.plugin_audience.output_base64sha256
  timeout          = 15
  memory_size      = 256

  environment {
    variables = {
      AUDIENCES_TABLE = aws_dynamodb_table.audiences.name
    }
  }
}

resource "aws_cloudwatch_log_group" "plugin_audience" {
  name              = "/aws/lambda/${aws_lambda_function.plugin_audience.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "gateway_invoke_plugin_audience" {
  statement_id  = "AllowGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.plugin_audience.function_name
  principal     = "bedrock-agentcore.amazonaws.com"
  source_arn    = aws_bedrockagentcore_gateway.plugins.gateway_arn
}

resource "aws_bedrockagentcore_gateway_target" "plugin_audience" {
  gateway_identifier = aws_bedrockagentcore_gateway.plugins.gateway_id
  name               = "plugin-audience"
  description        = "Audience / customer-360 — cohort affinity + territory-fit ranking."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.plugin_audience.arn

        # Tool 1 — list_audiences
        tool_schema {
          inline_payload {
            name        = "list_audiences"
            description = "List audience-intelligence cohorts (demographics + content affinity). Call BEFORE committing to a target segment to discover what exists."

            input_schema {
              type = "object"
            }

            output_schema {
              type = "object"
              property {
                name        = "segments"
                type        = "array"
                description = "Available cohorts, each with segment_id/name/description/demographics/size_estimate."
              }
            }
          }

          # Tool 2 — lookup_audience
          inline_payload {
            name        = "lookup_audience"
            description = "Fetch the full audience profile for a cohort — demographics, genre_affinity (index >1.0 over-indexed vs. general pop), daypart_affinity. Discover segment_id via list_audiences first."

            input_schema {
              type = "object"
              property {
                name        = "segment_id"
                type        = "string"
                description = "The cohort id — obtain via list_audiences."
              }
            }

            output_schema {
              type = "object"
              property {
                name        = "found"
                type        = "boolean"
                description = "Whether the segment existed."
              }
              property {
                name        = "name"
                type        = "string"
                description = "Human-readable cohort name."
              }
              property {
                name        = "genre_affinity"
                type        = "object"
                description = "Genre → affinity index map; >1.0 = over-indexed."
              }
            }
          }

          # Tool 3 — territory_fit (NEW; the Distribution-Readiness tool)
          inline_payload {
            name        = "territory_fit"
            description = "Rank audience cohorts by Distribution-Readiness relevance for a territory and optional genre/age brief. Returns candidates with score + human-readable reasoning. The 'is this a good market for this content' answer."

            input_schema {
              type = "object"
              property {
                name        = "territory"
                type        = "string"
                description = "Target territory ISO/short code (e.g. 'DE', 'US', 'EMEA')."
              }
              property {
                name        = "genre"
                type        = "string"
                description = "Optional genre keyword (drama/comedy/action/sports)."
              }
              property {
                name        = "age_band"
                type        = "string"
                description = "Optional target age band (e.g. '35-54')."
              }
            }

            output_schema {
              type = "object"
              property {
                name        = "candidates"
                type        = "array"
                description = "Ranked segments with score and reasons."
              }
              property {
                name        = "method"
                type        = "string"
                description = "One-line description of the scoring heuristic."
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_lambda_permission.gateway_invoke_plugin_audience]
}
