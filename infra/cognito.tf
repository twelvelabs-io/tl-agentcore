# Cognito User Pool — admin-managed users only, no self-signup.
#
# This is the "closed pilot" configuration: the only way to onboard a user
# is via an admin running `aws cognito-idp admin-create-user` (or this
# stack's aws_cognito_user resource for the seed admin). The Hosted UI's
# sign-up tab is hidden when allow_admin_create_user_only = true.
#
# Removal flow for an admin: `aws cognito-idp admin-delete-user
# --user-pool-id <pool> --username <email>`.

resource "aws_cognito_user_pool" "this" {
  name = "${local.fqname}-pool"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  admin_create_user_config {
    # CLOSED: no self-registration. Admins onboard everyone manually.
    allow_admin_create_user_only = true

    invite_message_template {
      email_subject = "Welcome to Rough Cut Lab"
      # HTML body. Cognito auto-detects HTML by content and sends it
      # with the appropriate Content-Type. Inline styles only (most email
      # clients strip <style> blocks). Web-safe fallback fonts in every
      # declaration — Cognito doesn't ship @font-face. Layout uses tables
      # because Outlook still doesn't reliably honor div layouts.
      #
      # Cognito placeholders: {username} → the invitee's email,
      # {####} → the one-time temporary password.
      email_message = <<-HTML
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>Welcome to Rough Cut Lab</title>
          </head>
          <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f6f4ef;color:#161514;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f4ef;">
              <tr><td align="center" style="padding:40px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border:1px solid #e2dccf;border-radius:12px;overflow:hidden;">
                  <tr><td style="padding:36px 36px 8px 36px;">
                    <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#ff7a1a;font-weight:700;">Welcome</div>
                    <h1 style="margin:10px 0 0 0;font-family:Georgia,'Times New Roman',serif;font-size:32px;color:#161514;line-height:1.1;font-weight:600;letter-spacing:-0.01em;">Rough Cut <span style="color:#ff7a1a;">·</span> Lab</h1>
                  </td></tr>
                  <tr><td style="padding:24px 36px 8px 36px;">
                    <p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#3c3a36;">
                      Hi <strong style="color:#161514;">{username}</strong>, you've been invited to <strong>Rough Cut Lab</strong> — the producer's studio for agentic highlight reels and rough cuts over your knowledge stores.
                    </p>
                    <p style="margin:0 0 12px 0;font-size:13px;color:#7a7975;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">
                      Your one-time password
                    </p>
                    <div style="margin:0 0 28px 0;padding:18px 22px;background:#f6f4ef;border:1px solid #e2dccf;border-radius:8px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:20px;letter-spacing:0.06em;color:#161514;text-align:center;font-weight:600;">{####}</div>
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                      <td bgcolor="#ff7a1a" style="border-radius:999px;">
                        <a href="https://d18q1864w6gq7b.cloudfront.net" style="display:inline-block;padding:13px 30px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:0.01em;">Sign in &rarr;</a>
                      </td>
                    </tr></table>
                    <p style="margin:28px 0 0 0;font-size:13px;line-height:1.6;color:#7a7975;">
                      You'll be asked to choose a permanent password on first sign-in. The temporary password above expires in <strong>7 days</strong>.
                    </p>
                  </td></tr>
                  <tr><td style="padding:24px 36px;border-top:1px solid #e2dccf;background:#fafaf7;">
                    <p style="margin:0;font-size:11px;line-height:1.6;color:#9a9890;font-family:'SFMono-Regular',Menlo,Consolas,monospace;">
                      If you weren't expecting this invitation, you can safely ignore this email.
                    </p>
                  </td></tr>
                </table>
                <p style="margin:18px 0 0 0;font-size:10px;color:#9a9890;font-family:'SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:0.04em;">
                  Bedrock AgentCore &middot; Marengo &middot; Pegasus
                </p>
              </td></tr>
            </table>
          </body>
        </html>
      HTML
      sms_message = "Rough Cut Lab — temp password for {username}: {####}"
    }
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_numbers   = true
    require_symbols   = true
    require_uppercase = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    mutable             = true
    required            = true
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
}

# Hosted UI domain. Cognito-hosted; no custom domain.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = "${local.fqname}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.this.id
}

# "admins" group — members can manage users via the AWS Console or CLI
# (admin-create-user, admin-delete-user, admin-add-user-to-group, etc.)
# using their own IAM permissions. The group itself doesn't grant Cognito
# admin rights — that's a Cognito API access concern, not a group membership
# concern — but it gives the UI a single attribute to gate "admin-only"
# pages on (e.g. a future user-management screen).
resource "aws_cognito_user_group" "admins" {
  name         = "admins"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Pool administrators — surfaced to the UI as the 'admin' claim."
  precedence   = 1
}

# Seed admin user. Created with a temporary password Cognito emails out;
# user is forced to reset on first sign-in. The user is also placed in the
# admins group.
resource "aws_cognito_user" "seed_admin" {
  count        = var.seed_admin_email == "" ? 0 : 1
  user_pool_id = aws_cognito_user_pool.this.id
  username     = var.seed_admin_email

  attributes = {
    email          = var.seed_admin_email
    email_verified = "true"
  }

  desired_delivery_mediums = ["EMAIL"]
  # Default behavior (omitting message_action) is what we want: Cognito
  # sends the standard invite email with the temporary password.
}

resource "aws_cognito_user_in_group" "seed_admin" {
  count        = var.seed_admin_email == "" ? 0 : 1
  user_pool_id = aws_cognito_user_pool.this.id
  group_name   = aws_cognito_user_group.admins.name
  username     = aws_cognito_user.seed_admin[0].username
}

# SPA app client — public client (no secret), Hosted UI flow.
resource "aws_cognito_user_pool_client" "spa" {
  name         = "${local.fqname}-spa"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  supported_identity_providers         = ["COGNITO"]

  callback_urls = [
    "https://${aws_cloudfront_distribution.frontend.domain_name}/",
    "http://localhost:5173/",
  ]
  logout_urls = [
    "https://${aws_cloudfront_distribution.frontend.domain_name}/",
    "http://localhost:5173/",
  ]

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"

  # Access/ID token validity is 1h so a stolen access token (e.g. from a
  # transient XSS) can be authorized only within its remaining life,
  # not for a full day. The SPA silently exchanges the long-lived
  # refresh token for a fresh access token before expiry
  # (ui/src/lib/auth.ts:getAccessToken), so producers don't see re-auth
  # prompts. Refresh token remains at 30d for the "one login per
  # month" UX.
  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

# Hosted-UI customization — themes the sign-in page to match the SPA's
# playground-aligned dark palette. Cognito only honors a fixed set of
# *-customizable class hooks; the CSS file targets those. Logo skipped
# (the 100x60 px limit can't accommodate the wordmark cleanly).
resource "aws_cognito_user_pool_ui_customization" "this" {
  user_pool_id = aws_cognito_user_pool.this.id
  client_id    = aws_cognito_user_pool_client.spa.id
  css          = file("${path.module}/cognito-ui.css")
}
