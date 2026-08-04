# HTTP API Gateway — fronts every browser-side AWS lambda. Routes are
# registered in the per-lambda *.tf files (kb_admin, kb_graph,
# presign_upload, embed_clip_start). This file just provisions the API
# itself + a $default stage.

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.fqname}-http"
  protocol_type = "HTTP"
  description   = "HTTP API — AWS-native browser proxy (kb_admin, kb_graph, presign_upload, embed_clip_start)."

  # CORS: `var.frontend_domain` is null on the first apply (CloudFront
  # doesn't exist yet) so we fall back to `*` there. Second apply,
  # after `terraform output frontend_url`, sets the variable and this
  # tightens to the actual SPA origin. CloudFront <-> API Gateway
  # forms a resource cycle if referenced directly, so we can't just
  # pull `aws_cloudfront_distribution.frontend.domain_name`.
  cors_configuration {
    allow_origins = var.frontend_domain != null && var.frontend_domain != "" ? [
      "https://${var.frontend_domain}",
      "http://localhost:5173",
    ] : ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
}

resource "aws_cloudwatch_log_group" "http_api_access" {
  name              = "/aws/apigateway/${local.fqname}-http"
  retention_in_days = 90
}

resource "aws_apigatewayv2_stage" "http_default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Access logging in Common Log Format-ish JSON. Every request
  # lands in the log group above with source IP, path, status,
  # integration latency, and the JWT sub the request authenticated
  # as (via the lambda; API Gateway doesn't do the JWT check).
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.http_api_access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      ip                 = "$context.identity.sourceIp"
      requestTime        = "$context.requestTime"
      httpMethod         = "$context.httpMethod"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      protocol           = "$context.protocol"
      responseLength     = "$context.responseLength"
      responseLatency    = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      userAgent          = "$context.identity.userAgent"
    })
  }
}
