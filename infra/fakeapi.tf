// Three fake third-party APIs, each exposing a public Lambda Function URL.
//
// The whole point of these is to prove the Distribution-Readiness plugin
// surface really does accept *any* HTTPS data source — not just the
// in-account Lambdas we shipped as reference plugins. Each API uses a
// different auth style so we exercise every path in the credential-provider
// plumbing landed in PR 5.
//
//   fakeapi-deliverables  — API key  (`X-API-Key: demo-del-k9x2`)
//   fakeapi-boxoffice     — Bearer    (`Authorization: Bearer demo-box-tok77`)
//   fakeapi-sentiment     — Basic     (`Authorization: Basic base64(demo-user:demo-pw)`)
//
// The expected credentials are hardcoded inside each lambda — the point
// here is to prove Gateway *injects* the right header on every call, not
// to stand up a real auth system behind the fake data. Secrets Manager
// still stores the credential at registration time (via the api-key
// credential provider), so the end-to-end plumbing is identical to how
// a real customer plugin would work; only the backend check is a demo.
//
// None of these are listed as plugins in the DDB table — an operator
// registers them via Settings → Data sources (POST /plugins). Terraform
// just stands up the fake backend + its public URL + prints the
// endpoints as outputs so the operator can paste them during
// registration.

locals {
  fakeapi_specs = {
    deliverables = {
      source_dir  = "${path.module}/../lambda/fakeapi_deliverables"
      description = "Fake deliverables-inventory API — demo API-key auth."
    }
    boxoffice = {
      source_dir  = "${path.module}/../lambda/fakeapi_boxoffice"
      description = "Fake box-office intelligence API — demo bearer-token auth."
    }
    sentiment = {
      source_dir  = "${path.module}/../lambda/fakeapi_sentiment"
      description = "Fake social-sentiment API — demo basic-auth."
    }
  }
}

data "archive_file" "fakeapi" {
  for_each    = local.fakeapi_specs
  type        = "zip"
  source_dir  = each.value.source_dir
  output_path = "${path.module}/.build/fakeapi_${each.key}.zip"
}

resource "aws_iam_role" "fakeapi" {
  for_each           = local.fakeapi_specs
  name               = "${local.fqname}-fakeapi-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "fakeapi_basic" {
  for_each   = local.fakeapi_specs
  role       = aws_iam_role.fakeapi[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "fakeapi" {
  for_each         = local.fakeapi_specs
  function_name    = "${local.fqname}-fakeapi-${each.key}"
  role             = aws_iam_role.fakeapi[each.key].arn
  runtime          = "python3.12"
  handler          = "index.handler"
  filename         = data.archive_file.fakeapi[each.key].output_path
  source_code_hash = data.archive_file.fakeapi[each.key].output_base64sha256
  timeout          = 10
  memory_size      = 128
  description      = each.value.description
}

resource "aws_cloudwatch_log_group" "fakeapi" {
  for_each          = local.fakeapi_specs
  name              = "/aws/lambda/${aws_lambda_function.fakeapi[each.key].function_name}"
  retention_in_days = 14
}

# Public Function URL. AuthType=NONE means AWS does NOT gate the URL —
# the hardcoded demo key / bearer / basic-auth check lives inside each
# lambda. This is the "customer stands up a public HTTPS endpoint" story.
resource "aws_lambda_function_url" "fakeapi" {
  for_each           = local.fakeapi_specs
  function_name      = aws_lambda_function.fakeapi[each.key].function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["GET"]
    allow_headers = ["authorization", "x-api-key", "content-type"]
    max_age       = 3600
  }
}

output "fakeapi_endpoints" {
  description = "Public Function URLs + the hardcoded demo credential for each fake third-party API. Paste the URL + credential into Settings → Data sources during plugin registration."
  value = {
    for key, _ in local.fakeapi_specs :
    key => {
      url            = aws_lambda_function_url.fakeapi[key].function_url
      openapi_schema = "see lambda/fakeapi_${key}/openapi.json — replace the servers[0].url placeholder with the url above before pasting"
      auth_mode = (
        key == "deliverables" ? "api_key (header X-API-Key, value demo-del-k9x2)"       :
        key == "boxoffice"    ? "bearer (token demo-box-tok77)"                         :
        key == "sentiment"    ? "basic (user demo-user, password demo-pw)"              :
        "unknown"
      )
    }
  }
}
