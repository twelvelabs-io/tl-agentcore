# infra — Terraform stack

Phase-1 deployment of the tl-agentcore reference architecture:

| Resource | Purpose |
|---|---|
| `aws_ecr_repository.agent` | Container registry for the Strands agent image (arm64) |
| `aws_bedrockagentcore_agent_runtime.this` | AgentCore Runtime running the container |
| `aws_bedrockagentcore_agent_runtime_endpoint.live` | Stable invoke target |
| `aws_s3vectors_vector_bucket.clips` + `aws_s3vectors_index.clips` | S3 Vectors store of Marengo clip embeddings (see whitepaper §4) |
| `aws_secretsmanager_secret.tl_api_key` | TwelveLabs API key the runtime reads |
| `aws_iam_role.runtime` | Execution role (ECR pull + Bedrock invoke + s3vectors:Query/Get + Secrets) |

The agent runs with **in-process tools** (`agent/tl_agentcore/agent.py`). The
AgentCore Gateway path is documented in `gateway.tf` but not enabled —
that's a Phase-2 follow-up.

## Deploy

```bash
cd infra
terraform init
terraform apply \
  -var "tl_api_key=tlk_XXXX" \
  -var "aws_profile=your-profile"
```

Build + push the agent container:

```bash
./build-agent.sh
# prints a TAG; then:
terraform apply -var agent_image_tag=v20260514...
```

Build the vector index for a knowledge store:

```bash
cd ..
export VECTOR_BUCKET_NAME=$(terraform -chdir=infra output -raw vector_bucket_name)
export VECTOR_INDEX_NAME=$(terraform -chdir=infra output -raw vector_index_name)
python scripts/ingest_vectors.py ks_<id>
```

## Known prerequisites & gotchas

- **AWS provider ≥ 6.30** for `aws_bedrockagentcore_*`. The `~> 6.43`
  pin in `main.tf` covers it.
- **AgentCore Runtime is arm64-only.** linux/amd64 images get rejected at
  `CreateAgentRuntime` with `Architecture incompatible`. `build-agent.sh`
  uses `docker buildx --platform linux/arm64`.
- **`agent_image_tag` must change** to force the runtime to re-resolve the
  image digest. Pushing to `:latest` alone won't restart the agent.
- **`runtime-session-id` must be ≥33 chars** when invoking the runtime.
- **Trust policy without `aws:SourceAccount`.** Some accounts reject the
  conditioned form at gateway-target creation. We leave it off for
  portability.
