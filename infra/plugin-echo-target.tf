# Reference AgentCore Gateway Lambda target: `plugin_echo`.
#
# PR 1 demo validator — proves the plugin loader can discover and call
# a Gateway-registered tool end-to-end. The Lambda is intentionally
# trivial (returns whatever message you pass it); the Terraform here
# is the interesting part because it's the template PR 2's three
# reference MCP servers will be built from.

locals {
  plugin_echo_root = "${path.module}/../lambda/plugin_echo"
}

data "archive_file" "plugin_echo" {
  type        = "zip"
  source_dir  = local.plugin_echo_root
  output_path = "${path.module}/.build/plugin_echo.zip"
}

resource "aws_iam_role" "plugin_echo" {
  name               = "${local.fqname}-plugin-echo"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "plugin_echo_basic" {
  role       = aws_iam_role.plugin_echo.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "plugin_echo" {
  function_name    = "${local.fqname}-plugin-echo"
  role             = aws_iam_role.plugin_echo.arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.plugin_echo.output_path
  source_code_hash = data.archive_file.plugin_echo.output_base64sha256
  timeout          = 10
  memory_size      = 128
}

resource "aws_cloudwatch_log_group" "plugin_echo" {
  name              = "/aws/lambda/${aws_lambda_function.plugin_echo.function_name}"
  retention_in_days = 14
}

# Let AgentCore Gateway invoke the Lambda. Gateway's own role already
# has lambda:InvokeFunction on every ${local.fqname}-* function (see
# gateway.tf), but AWS still requires the resource-based policy on
# each Lambda target.
resource "aws_lambda_permission" "gateway_invoke_plugin_echo" {
  statement_id  = "AllowGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.plugin_echo.function_name
  principal     = "bedrock-agentcore.amazonaws.com"
  source_arn    = aws_bedrockagentcore_gateway.plugins.gateway_arn
}

# Gateway target. Each tool_schema.inline_payload describes one MCP
# tool the gateway exposes; the gateway unwraps the tools/call MCP
# message and delivers {tool, arguments} to the Lambda.
resource "aws_bedrockagentcore_gateway_target" "plugin_echo" {
  gateway_identifier = aws_bedrockagentcore_gateway.plugins.gateway_id
  name               = "plugin-echo"
  description        = "Reference echo tool — plugin surface health check."

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      lambda {
        lambda_arn = aws_lambda_function.plugin_echo.arn

        tool_schema {
          inline_payload {
            name        = "plugin_echo"
            description = "Echo tool used to validate the plugin surface. Returns the message you pass in. Not a real data source."

            input_schema {
              type = "object"
              property {
                name        = "message"
                type        = "string"
                description = "Any string. Returned verbatim in `echoed`."
              }
            }

            output_schema {
              type = "object"
              property {
                name        = "echoed"
                type        = "string"
                description = "The same string you passed in."
              }
              property {
                name        = "length"
                type        = "integer"
                description = "Length of the echoed message."
              }
            }
          }
        }
      }
    }
  }

  depends_on = [aws_lambda_permission.gateway_invoke_plugin_echo]
}
