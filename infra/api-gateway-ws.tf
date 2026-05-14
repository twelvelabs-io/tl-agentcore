# API Gateway WebSocket — fronts the chat lambda.
# Browser opens wss://<cf-domain>/live?token=<jwt> → CloudFront passes through
# to wss://<wsapi-domain>/live → API GW upgrades → chat lambda's $connect.

resource "aws_apigatewayv2_api" "ws" {
  name                       = "${local.fqname}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
  description                = "WebSocket for the tl-agentcore chat surface — bypasses the HTTP 30s cap via async self-invoke in the lambda."
}

resource "aws_apigatewayv2_integration" "ws_chat" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.chat.invoke_arn
  integration_method        = "POST"
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "ws_connect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_chat.id}"
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_chat.id}"
}

resource "aws_apigatewayv2_route" "ws_default" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_chat.id}"
}

resource "aws_apigatewayv2_stage" "ws_live" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "live"
  auto_deploy = true
}

resource "aws_lambda_permission" "ws_invoke_chat" {
  statement_id  = "AllowWsInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chat.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*"
}
