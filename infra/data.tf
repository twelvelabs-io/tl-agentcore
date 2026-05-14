# Self-contained: this stack owns the Secrets Manager entry for the TL key.
# (Earlier internal versions of this stack pulled it from a sibling Bedrock
# Agents stack via terraform_remote_state — that coupling is gone.)

resource "aws_secretsmanager_secret" "tl_api_key" {
  name        = "${local.fqname}-tl-api-key"
  description = "TwelveLabs API key consumed by the AgentCore Runtime container."
}

resource "aws_secretsmanager_secret_version" "tl_api_key" {
  count         = var.tl_api_key == "" ? 0 : 1
  secret_id     = aws_secretsmanager_secret.tl_api_key.id
  secret_string = var.tl_api_key
}
