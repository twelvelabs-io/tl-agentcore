# WAFv2 web ACL attached to the frontend CloudFront distribution.
# Scope must be CLOUDFRONT, which requires the resource to live in
# us-east-1. The stack's default region is already us-east-1
# (variables.tf); if it ever moves, add a `provider "aws"` alias
# pinned to us-east-1 and set `provider = aws.us_east_1` on this
# resource.
#
# AWS managed rule groups do the heavy lifting:
#   - AWSManagedRulesCommonRuleSet — CRS-like coverage (XSS, LFI,
#     no-user-agent, oversized bodies, etc.)
#   - AWSManagedRulesKnownBadInputsRuleSet — signatures for exploits
#     in the wild (Log4Shell, ProxyLogon, path-traversal payloads)
#
# Both are `override_action = none` — WAF blocks matches by default.
# Metrics are on so CloudWatch shows rule hits in real time.

resource "aws_wafv2_web_acl" "frontend" {
  name        = "${local.fqname}-frontend"
  description = "CRS + known-bad-inputs for the tl-agentcore SPA."
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fqname}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.fqname}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.fqname}-waf"
    sampled_requests_enabled   = true
  }
}
