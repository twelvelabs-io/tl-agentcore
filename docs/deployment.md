# Deployment

Operator-facing notes for standing up the reference architecture
described in [`whitepaper.md`](whitepaper.md). The paper covers the
*why*; this doc covers the *how*.

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

Build and push the agent container (arm64-only; AgentCore runs on
Graviton):

```bash
./build-agent.sh   # docker buildx build --platform linux/arm64 ...
```

Build the vector index for an existing knowledge store. The operator
stages asset bytes into the clips bucket first (the demo flow does this
inline in `scripts/setup_test_fixtures.sh`), then runs:

```bash
export CLIPS_BUCKET_NAME=$(cd infra && terraform output -raw clips_bucket_name)
export VECTOR_BUCKET_NAME=$(cd infra && terraform output -raw vector_bucket_name)
export TL_API_KEY=tlk_...     # only used to enumerate KS items

python scripts/ingest_vectors.py ks_<id>
```

The script talks only to AWS (S3, Bedrock, S3 Vectors) once the asset
bytes are staged. Bedrock Marengo 3.0 runs via StartAsyncInvoke,
returning the standard `data[].embedding` shape; clip-scope segments are
upserted into the S3 Vectors index.

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
