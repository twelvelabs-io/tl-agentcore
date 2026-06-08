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
      email_subject = "Your tl-agentcore lab access"
      email_message = "Hi {username}, you have been granted access to the tl-agentcore lab. Your temporary password is: {####}. Sign in at the URL the inviter shared with you; you'll be asked to set a new password on first sign-in."
      sms_message   = "Username: {username}, temp password: {####}"
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

  access_token_validity  = 24
  id_token_validity      = 24
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
