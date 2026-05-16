# tl-agentcore — Rough Cut / Highlight Reel on AWS AgentCore

Reference implementation of an **agentic rough-cut / highlight-clipping
system** built on AWS Bedrock AgentCore (Runtime + Gateway) with
TwelveLabs Marengo and Pegasus, retrieving over an S3 Vectors index.

This repo is the companion artifact to the joint AWS × TwelveLabs white
paper in [`docs/whitepaper.md`](docs/whitepaper.md).

## What it does

Producer types a prompt:

> *"Build me a 60-second action highlight reel from the F1 Brazil GP, punchy cuts, end on a celebration."*

…and gets back a structured Edit Decision List (EDL): scenes, in/out
timecodes, clip IDs, role hints, and a one-line *why* per clip. Playable
back-to-back from HLS sources, or exportable as XML/CSV for Premiere /
Resolve.

The retrieval layer is embedding-RAG over video clips. At ingest, every
asset in the knowledge store is segmented and embedded by Marengo into
clip-level vectors stored in an S3 Vectors index. At query time, the
agent embeds each producer beat through Marengo's text encoder (same
512-dim vector space) and runs an ANN query against the index, scoped
to the active knowledge store via a metadata filter. Rank 1 is the
primary; ranks 2–5 are the producer-swappable alternates.

| Tool | Latency | Use |
|---|---|---|
| `vector_search` | ~250 ms | Marengo text embed + S3 Vectors ANN; one call per beat in parallel |
| `pegasus_analyze` | 5–15 s | Optional take-note for the chosen primary |
| `list_tl_indexes` | <1 s | Discovery, rarely needed once the index is in context |

## Layout

```
agent/        Python Strands agent (tools + runtime + arm64 Dockerfile)
ui/           React + Vite SPA (Rough Cut tab + Agent tab + Playwright E2E)
lambda/       chat lambda (WebSocket -> InvokeAgentRuntime) and tl_proxy
infra/        Terraform: AgentCore Runtime, S3 Vectors, Cognito,
              CloudFront + S3, API Gateways
scripts/      ingest_vectors.py + setup_test_fixtures.sh
docs/         Whitepaper + scope doc
```

## Quick start

```bash
# 1. Backend
cd agent && uv venv && source .venv/bin/activate && uv pip install -r requirements.txt
cp ../.env.example ../.env  # fill in TL_API_KEY
python local_run.py ks_abc123 "build me a 30s tension reel"

# 2. Build the vector index (one-time per knowledge store)
export VECTOR_BUCKET_NAME=$(terraform -chdir=../infra output -raw vector_bucket_name)
python ../scripts/ingest_vectors.py ks_abc123

# 3. UI
cd ../ui && npm install && npm run dev
```

## Deploy to AgentCore

```bash
cd infra
terraform init
terraform apply
# Creates the AgentCore Runtime, S3 Vectors bucket + index, Cognito pool,
# API Gateways, CloudFront, and the chat + tl_proxy lambdas.
```

See `infra/README.md` for variable reference and the [whitepaper §6
"deployment recipe"](docs/whitepaper.md#6-deployment-recipe).

## Authors

- TwelveLabs
- AWS
