# Deployment

Operator-facing notes for standing up the AgentCore + S3 Vectors +
TwelveLabs reference architecture.

## What the stack provisions

Terraform-only deployment. The stack under `infra/` provisions, end to
end:

- **Runtime.** `aws_bedrockagentcore_agent_runtime` running the Strands
  agent container (arm64 Graviton, pulled from ECR by tag), with a
  versioned `aws_bedrockagentcore_agent_runtime_endpoint` for callers.
- **Vector index.** S3 Vectors bucket holding one Marengo embedding per
  segmented clip, attributed with `asset_id`, `knowledge_store_id`,
  `start_sec`, `end_sec`, and `s3_uri`. The agent's `vector_search` tool
  filters by `knowledge_store_id` so a single index serves multiple KSs.
- **Clips bucket.** Private S3 bucket holding the mirrored asset bytes
  at `clips/<asset_id>.mp4`. Bedrock's TwelveLabs models read media only
  from S3 (no URL form is accepted), so both the embedder (Marengo via
  StartAsyncInvoke) and the analyzer (Pegasus via InvokeModel) point at
  this bucket. Async-invoke output lands under `embeddings/<id>/` with a
  seven-day lifecycle rule.
- **Edge + transport.** CloudFront fronts an S3 bucket of built UI
  assets plus two API Gateway origins: a WebSocket for the chat lambda
  that invokes the runtime, and an HTTP API for the `tl_proxy` lambda
  that forwards `/tl/*` browser calls to the TwelveLabs API.
- **Identity.** Cognito User Pool with `allow_admin_create_user_only =
  true`: no self-registration, and admins onboard every user via
  `aws cognito-idp admin-create-user`. An `admins` group surfaces the
  admin role to the UI as a claim. The Cognito JWT flows end-to-end
  from browser through CloudFront, through the WebSocket and HTTP APIs,
  and into the lambdas that verify it before invoking the runtime.
- **Secrets.** The TwelveLabs API key lives in Secrets Manager. The
  `tl_proxy` lambda reads it for the browser playback proxy. The runtime
  container reads it only when `PEGASUS_PROVIDER=tl_api` is set on the
  runtime (the opt-in path that swaps `pegasus_analyze` from Bedrock 1.2
  to TwelveLabs `/v1.3/analyze`, e.g. to use Pegasus 1.5 before it ships
  to Bedrock Marketplace). With the default `bedrock` setting, the
  runtime never touches the secret.
- **Gateway.** `gateway.tf` is documented but not enabled in this
  reference implementation. A future evolution moves the agent tools
  out of the runtime container into MCP-served lambdas behind
  AgentCore Gateway, so the tool catalog is administered as
  infrastructure instead of code.

## Apply

```bash
cd infra
terraform init
terraform apply -var="tl_api_key=tlk_..." -var="seed_admin_email=you@example.com"
```

## First admin user

`seed_admin_email` is the only way to get a working session on a
brand-new pool. `allow_admin_create_user_only = true` blocks
self-registration, and the Users tab in the SPA is gated on membership
in the `admins` Cognito group. Until at least one admin exists, nobody
can invite anyone else.

On first `terraform apply` with the variable set:

1. `aws_cognito_user.seed_admin` creates the user with
   `email_verified = true` and `desired_delivery_mediums = ["EMAIL"]`.
2. Cognito generates a temporary password (Terraform never sees it; it
   is not written to state) and sends the standard invite email to that
   address: an HTML message with the temp password, a 7-day expiry
   note, and a `Sign in` button pointing at the CloudFront URL.
3. `aws_cognito_user_in_group.seed_admin` adds the user to the `admins`
   group. The access token they receive at sign-in then carries
   `cognito:groups: ["admins"]`, which unlocks Settings → Users.
4. The admin clicks the link in the email, lands on the SPA's local
   sign-in screen, sets a permanent password via the
   `FORCE_CHANGE_PASSWORD` challenge, and signs in. From there they
   invite everyone else through the in-app Users tab. No further
   Terraform is required.

If the invite email is lost or spam-filtered, re-fire it:

```bash
terraform taint  aws_cognito_user.seed_admin
terraform apply  -var "tl_api_key=tlk_..." -var "seed_admin_email=you@example.com"
```

Tainting recreates the resource on the next apply, which makes Cognito
issue a fresh temporary password and send the invite again. Same
outcome as the Users tab's per-row "resend invite" button, but usable
before any admin exists in the pool.

If `seed_admin_email` is left blank, the deployment finishes with a
working pool that has zero users. To recover, an operator with AWS
CLI access can bootstrap manually:

```bash
POOL_ID=$(terraform -chdir=infra output -raw cognito_user_pool_id)
EMAIL=you@example.com

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL_ID" --username "$EMAIL" --group-name admins
```

## Agent container

Build and push the agent container (arm64-only; AgentCore runs on
Graviton):

```bash
./build-agent.sh   # docker buildx build --platform linux/arm64 ...
```

## Ingesting video

Use the SPA's Library tab to upload. The auto-pipeline takes it from
there, no manual scripts required:

1. `presign_upload` hands the browser a PUT URL into the clips bucket.
2. S3 PutObject fires `embed_clip_start`, which kicks off MediaConvert
   HLS transcode and Bedrock Marengo `StartAsyncInvoke` in parallel.
3. `embed_clip_finalize` upserts segment vectors into S3 Vectors;
   `hls_finalize` finalizes the playback manifest.
4. `asset_profile` runs Pegasus and writes the per-asset summary into
   `kb_cache`; `ks_rollup` (EventBridge, every 4 h) aggregates the
   per-KS `OVERVIEW`, `ENTITY#` and `EVENT#` rows.

Bedrock Marengo 3.0 runs via `StartAsyncInvoke`, returning the standard
`data[].embedding` shape; clip-scope segments land in S3 Vectors with
`asset_id`, `knowledge_store_id`, `start_sec`, `end_sec`, and `s3_uri`
as filterable metadata.

## Implementation notes

Operational gotchas worth knowing before the first apply:

- **AgentCore Runtime is arm64-only.** linux/amd64 images get rejected
  at `CreateAgentRuntime` with `Architecture incompatible`.
- **API Gateway WebSocket has a 30 s integration cap.** It cannot be
  raised, which forces an async self-invoke pattern in the chat lambda.
- **Async lambda retry produces phantom duplicate runs.**
  `aws_lambda_function_event_invoke_config { maximum_retry_attempts = 0 }`
  is mandatory; otherwise every timeout fires the agent twice.
- **`runtime-session-id` must be ≥33 characters.** Short ids are
  rejected; pad them before invoking.
- **AWS provider ≥6.30** is required for `aws_bedrockagentcore_*`
  resources.
- **AgentCore Runtime → custom HTTP timeouts.** AWS SDK default
  socketTimeout (180 s) is below the 300 s lambda cap. Set
  NodeHttpHandler `socketTimeout: 280_000` explicitly.
- **S3 Vectors filterable metadata is bounded.** Per-vector metadata is
  capped; keep the attribute set to the five fields the agent actually
  filters, returns, or hands to Pegasus (`asset_id`,
  `knowledge_store_id`, `start_sec`, `end_sec`, `s3_uri`). Anything
  richer belongs in a separate metadata store.
- **Bedrock TwelveLabs models require s3Location, not URL.** Neither
  Marengo nor Pegasus on Bedrock accepts a plain URL for media. The
  reference stack mirrors each ingested asset to `clips/<asset_id>.mp4`
  on the clips bucket; the runtime IAM role carries `s3:GetObject`
  there. Sub-clip time ranges are not supported on the Pegasus 1.2
  Bedrock API, so the whole S3 object is analyzed; deployments with
  long source videos should consider segmenting at ingest time.
- **Marengo on Bedrock is async-only for video.** Sync `InvokeModel`
  rejects `inputType=video`; use `StartAsyncInvoke` against the
  foundation-model ARN (not the inference profile). Output writes to
  `s3://<clips bucket>/embeddings/<invocation_id>/output.json`.
