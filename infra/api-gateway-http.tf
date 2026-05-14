# HTTP API Gateway — fronts the tl_proxy lambda for /tl/* browser calls.
# Routes:
#   ANY /tl/{proxy+} → tl_proxy lambda
#
# CORS handled at the lambda (it returns the allow-origin header). API
# Gateway's built-in CORS is on too as a backstop for preflight.

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.fqname}-http"
  protocol_type = "HTTP"
  description   = "HTTP API — /tl/* proxy for the browser."

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type", "x-api-key"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "tl_proxy" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.tl_proxy.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "tl_proxy_any" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "ANY /tl/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.tl_proxy.id}"
}

resource "aws_apigatewayv2_stage" "http_default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "http_invoke_tl_proxy" {
  statement_id  = "AllowHttpInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tl_proxy.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
