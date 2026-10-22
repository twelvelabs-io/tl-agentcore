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
  assets plus one HTTP API Gateway that routes `/kb/*`, `/kb-graph`,
  `/upload/*`, `/settings/*`, `/users/*`, `/stitch*`, and
  `/scores/{response_id}` to the respective lambdas. The agent stream
  is browser-direct to `wss://bedrock-agentcore.<region>.amazonaws.com`
  — no chat-lambda relay, no WS API Gateway (v0.3+ removed both).
- **Identity.** Cognito User Pool with `allow_admin_create_user_only =
  true`: no self-registration, and admins onboard every user via
  `aws cognito-idp admin-create-user`. An `admins` group surfaces the
  admin role to the UI as a claim. The Cognito JWT flows end-to-end
  from browser through CloudFront to the HTTP API + AgentCore Runtime
  authorizer.
- **Bedrock model access.** The runtime calls Marengo 3.0, Pegasus 1.5,
  and Claude Sonnet 4.6 through the Bedrock Marketplace / Anthropic
  Bedrock catalog. Grant model access in the Bedrock console
  (Model access → Manage model access) before the first invoke.
  us-east-1 is the region we default to. Pegasus "1.5" on Bedrock is
  functionally the same model as SaaS Pegasus 1.6 — the Bedrock
  version string lags, there is no capability gap. The agent code
  pins the inference profile `us.twelvelabs.pegasus-1-5-v1:0`; both
  1.2 and 1.5 ARNs are IAM-allowlisted so a rollback is a one-var
  flip (`-var pegasus_bedrock_model_id="us.twelvelabs.pegasus-1-2-v1:0"`).
- **Gateway.** `gateway.tf` is documented but not enabled in this
  reference implementation. A future evolution moves the agent tools
  out of the runtime container into MCP-served lambdas behind
  AgentCore Gateway, so the tool catalog is administered as
  infrastructure instead of code.

## Apply

Two-phase on a fresh account. The AgentCore runtime resource wants an
ECR image with a specific tag, and that tag doesn't exist until
`build-agent.sh` has pushed one — so create the ECR repo first, push
the image, then apply the rest.

Pass `-var aws_profile=<your-named-profile>` on every apply — the
provider block pins to `var.aws_profile` (default `"default"`), so
`AWS_PROFILE=…` alone in the environment is ignored by Terraform.

```bash
cd infra
terraform init

# Install lambda deps. The terraform archive_file resources zip each
# lambda's directory verbatim — including node_modules. On a fresh
# clone, node_modules/ doesn't exist, so any lambda that imports a
# third-party module (aws-jwt-verify, @aws-sdk/*) 500s at runtime
# with "Cannot find package …". Idempotent, one-time per host.
./install-lambda-deps.sh

# Phase 1 — the ECR repo the runtime image needs to exist before the
# runtime resource. -target picks up its transitive dependencies too.
terraform apply \
  -var="aws_profile=your-profile" \
  -var="seed_admin_email=you@example.com" \
  -target=aws_ecr_repository.agent

# Push the agent container. Prints a v<timestamp> tag on the last line.
./build-agent.sh

# Phase 2 — full apply pointed at the tag you just pushed. Creates the
# runtime + everything else.
terraform apply \
  -var="aws_profile=your-profile" \
  -var="seed_admin_email=you@example.com" \
  -var="agent_image_tag=<v-timestamp-from-build-agent.sh>"
```

If you cloned before running `install-lambda-deps.sh`, don't worry —
just run it now and repeat the phase 2 apply. Terraform detects the
archive hash change and redeploys every lambda whose deps just landed.

Subsequent applies are single-phase — pass the current `agent_image_tag`
each time so Terraform doesn't try to downgrade the runtime to the
`v0` default.

The `hash_key is deprecated. Use key_schema instead` warning on the
DynamoDB tables is a soft AWS-provider deprecation notice (the
replacement syntax isn't yet shipped in `hashicorp/aws ~> 6.43`).
Non-blocking and safe to ignore; the resources apply correctly.

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
terraform apply  -var "aws_profile=your-profile" -var "seed_admin_email=you@example.com" -var "agent_image_tag=<v-tag>"
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

Extracting the release zip strips executable bits — `chmod +x` the
build script once:

```bash
chmod +x infra/build-agent.sh
```

Subsequent rebuilds (after code changes) are one-liners; the ECR repo
already exists.

```bash
./build-agent.sh                                # prints v<timestamp>
terraform apply -var="agent_image_tag=<v-timestamp>" ...
```

The image is arm64-only; AgentCore runs on Graviton and rejects amd64
images at `CreateAgentRuntime` with `Architecture incompatible`. On
first run the script pre-downloads the arm64 pip wheels
(`agent/wheels/`) — a one-time cost per host, subsequent builds reuse
the folder. Requires Docker Desktop or a similar buildx-capable
runtime.

## Frontend

The Terraform apply creates the CloudFront distribution + S3 bucket
but doesn't build or upload the SPA — that's a separate step so
operators can rebuild the UI without touching infrastructure.

```bash
# 1. Pull the stamped-in env vars into ui/.env.production. Every
#    VITE_* value is what the SPA needs to reach Cognito + AgentCore
#    + the API Gateway endpoints, plus the CloudFront origin the
#    invite email links to.
cd infra
terraform output -raw ui_env > ../ui/.env.production
cd ..

# 2. Build the SPA. Vite reads .env.production automatically.
cd ui
npm install
npm run build

# 3. Upload the built assets to the frontend bucket + invalidate
#    CloudFront so users get the fresh bundle immediately.
FRONTEND_BUCKET=$(terraform -chdir=../infra output -raw frontend_bucket)
DIST_ID=$(terraform -chdir=../infra output -raw cloudfront_distribution_id)
aws s3 sync dist/ s3://$FRONTEND_BUCKET/ --profile <your-profile> --delete
aws cloudfront create-invalidation \
  --distribution-id $DIST_ID --paths "/*" --profile <your-profile>
```

The seed admin's invite email links to `terraform output frontend_url`,
so make sure the SPA is deployed before the admin clicks through.

## Tighten CORS after first apply

The first `terraform apply` doesn't know the CloudFront domain (it
gets minted in the same apply), so API Gateway's CORS
`allow_origins` falls back to `*`. That's still safe on its own —
every lambda verifies a Cognito JWT — but tightening it to the
specific SPA origin removes a defense-in-depth gap against
token-theft cross-origin abuse. After the first apply completes,
grab the CloudFront domain and re-apply with the variable set:

```bash
cd infra
DOMAIN=$(terraform output -raw frontend_url | sed 's|https://||')
terraform apply -var "frontend_domain=$DOMAIN" -var "aws_profile=<your-profile>"
```

Both applies converge on the same infra — the second one just
narrows the CORS allowlist. Add this variable to your CI-run
tfvars going forward.

## Pricing + web search

Two wave-2 subsystems are activated out-of-band via SSM
parameters, not Terraform variables, so ops can rotate / bump without
touching the stack:

- **Per-model prices** (metering ledger) — write JSON blobs to
  `/tl-agentcore/prices/<model_id>` with shape
  `{"input_per_mtok": 3.0, "output_per_mtok": 15.0, "currency": "USD"}`.
  The runtime caches with a 15 min TTL (`PRICES_CACHE_TTL_SECONDS`).
  Missing parameters are cached as "unknown price" and still write
  a `usage_events` row with `cost=null`.
- **Hosted web search** — `WEB_SEARCH_PROVIDER` env var picks the
  provider; default `brave` (adapter in
  `agent/tl_agentcore/web_search/brave.py`). Set to `none` to
  disable the tool with an explanatory error. If a different
  provider is needed, add an adapter next to `brave.py` and extend
  `select_provider()` in `provider.py`. The API key is a
  SecureString SSM parameter at `/tl-agentcore/web-search/<provider>`
  — Terraform does NOT create the parameter, so ops writes the key
  out of band to keep the KMS encryption context in
  operator-controlled scope. For Brave: get a key from
  https://api.search.brave.com (free tier is 2K queries/month), then
  `aws ssm put-parameter --name /tl-agentcore/web-search/brave --type
  SecureString --value <key>`. The runtime caches the key for 5 min
  (`WEB_SEARCH_API_KEY_CACHE_TTL_SECONDS`), so rotating is just
  overwriting the parameter and waiting out the TTL.

## Lambda surface

The stack provisions one lambda per capability. Deploy artifacts land
under `lambda/<name>/` with Node 20 and a per-lambda `package.json`;
`install-lambda-deps.sh` installs the aws-sdk + jwt-verify bundle for
each one.

| Lambda | Trigger | Purpose |
|---|---|---|
| `kb_admin` | HTTP `/kb/*` | Knowledge-store + asset CRUD (DDB-backed). |
| `kb_graph` | HTTP `/kb-graph` | Neptune-backed subgraph for the Graph tab. |
| `presign_upload` | HTTP `/upload/presign` | Browser upload URL. |
| `embed_clip_start` | HTTP `/upload/embed` | Kicks off MediaConvert HLS + Marengo async. |
| `embed_clip_finalize` | S3 event | Upserts Marengo vectors into S3 Vectors. |
| `hls_finalize` | S3 event | Finalizes playback manifest + flips status. |
| `asset_profile` | S3 event | Pegasus run + per-asset profile write. |
| `enrich_comprehend` | S3 event | Comprehend sentiment + entities, writes graph. |
| `enrich_transcribe_start` | S3 event | ASR start for audio-context tool. |
| `index_faces` | async | Rekognition face indexing per-KS. |
| `ks_rollup` | EventBridge (4 h) | Aggregates OVERVIEW / ENTITY# / EVENT#. |
| `graph_backfill` | manual / cron | One-shot backfill of the Neptune graph. |
| `mining_run` | EventBridge Scheduler | Executes a jockey_save plan on its schedule. |
| `settings` | HTTP `/settings/*` | System-prompt view/edit (admin-gated). |
| `stitch` | HTTP `/stitch*` | MediaConvert render preview. |
| `users` | HTTP `/users*` | Cognito user management (admin-only). |
| `scores` | HTTP `/scores/{response_id}` | Returns online judge rows for a turn. |

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

## Teardown

`terraform destroy` on this stack has two known ordering quirks. Both
have one-line workarounds; documenting them here so a POC teardown
doesn't leave orphaned AWS resources.

```bash
# 1. The Cognito UI customization can only be modified while its
#    domain still exists, but Terraform tries to destroy them in
#    parallel. Drop the UI customization from state first.
terraform state rm aws_cognito_user_pool_ui_customization.this

# 2. terraform destroy on the clips bucket will succeed for greenfield
#    tests via the `force_destroy = true` on the resource. If you
#    forked before v0.4.6 or set force_destroy=false, empty the bucket
#    manually first:
# aws s3 rm s3://<clips-bucket> --recursive --profile <your-profile>

# Now destroy cleanly.
terraform destroy \
  -var="aws_profile=your-profile" \
  -var="seed_admin_email=you@example.com" \
  -var="agent_image_tag=<v-tag>"
```

## Implementation notes

Operational gotchas worth knowing before the first apply:

- **AgentCore Runtime is arm64-only.** linux/amd64 images get rejected
  at `CreateAgentRuntime` with `Architecture incompatible`.
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
  there. Pegasus 1.5 on Bedrock supports sub-clip time ranges
  (`startTime`/`endTime` in the request body); the reference agent
  does not yet pass them, so today the whole S3 object is analyzed
  per invocation.
- **Marengo on Bedrock is async-only for video.** Sync `InvokeModel`
  rejects `inputType=video`; use `StartAsyncInvoke` against the
  foundation-model ARN (not the inference profile). Output writes to
  `s3://<clips bucket>/embeddings/<invocation_id>/output.json`.
