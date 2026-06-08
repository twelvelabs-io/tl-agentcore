# HTTP API Gateway — fronts every browser-side AWS lambda. Routes are
# registered in the per-lambda *.tf files (kb_admin, kb_graph,
# presign_upload, embed_clip_start). This file just provisions the API
# itself + a $default stage.

resource "aws_apigatewayv2_api" "http" {
  name          = "${local.fqname}-http"
  protocol_type = "HTTP"
  description   = "HTTP API — AWS-native browser proxy (kb_admin, kb_graph, presign_upload, embed_clip_start)."

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type", "x-demo-password"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_stage" "http_default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}
