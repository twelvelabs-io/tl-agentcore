# tl-agentcore — Rough Cut / Highlight Reel on AWS AgentCore

Reference implementation of an **agentic rough-cut / highlight-clipping system**
built on AWS Bedrock AgentCore (Runtime + Gateway) and TwelveLabs video
understanding models (Marengo + Pegasus).

This repo is the companion artifact to the joint AWS × TwelveLabs white paper
in [`docs/whitepaper.md`](docs/whitepaper.md).

## What it does

Producer types a prompt:

> *"Build me a 60-second action highlight reel from the F1 Brazil GP — punchy cuts, end on a celebration."*

…and gets back a structured Edit Decision List (EDL): scenes, in/out
timecodes, clip IDs, role hints, and a one-line *why* per clip — playable
back-to-back from HLS sources, or exportable as XML/CSV for Premiere/Resolve.

The agent does it by orchestrating three TwelveLabs primitives:

| Tier | Tool | Latency | Use |
|---|---|---|---|
| 1 | `profile_cache` (DDB) | <10 ms | Pre-built per-asset profile lookup |
| 2 | `marengo_search` | 1–10 s | Semantic clip-level retrieval |
| 3 | `pegasus_analyze` | 5–30 s | Per-clip generative analysis |

The "cache-first" pattern is what makes this fast enough for a producer
workflow — see whitepaper §4.

## Layout

```
agent/        Python Strands agent — tools + runtime + Dockerfile (arm64)
ui/           React + Vite demo UI (RoughCut + AgentCore live-arch view)
infra/        Terraform — AgentCore Runtime, Gateway, profile_cache DDB, ECR
scripts/      Ingestion utility (ingest_profile_cache.py)
docs/         White paper + reference docs
tests/        End-to-end pipeline tests against a real KB
```

## Quick start

```bash
# 1. Backend
cd agent && uv venv && source .venv/bin/activate && uv pip install -r requirements.txt
cp ../.env.example ../.env  # fill in TL_API_KEY
python local_run.py "build me a 30s tension reel from ks_abc123"

# 2. Build the cache (one-time per knowledge store)
python ../scripts/ingest_profile_cache.py ks_abc123

# 3. UI
cd ../ui && npm install && npm run dev
```

## Deploy to AgentCore

```bash
cd infra
terraform init
terraform apply
# pushes the agent container to ECR, creates the AgentCore Runtime + Gateway,
# wires profile_cache DDB perms.
```

See `infra/README.md` for variable reference and the [whitepaper §6
"deployment recipe"](docs/whitepaper.md#6-deployment-recipe).

## Status

**Skeleton — May 2026.** This repo is being extracted from an internal lab.
Some directories are placeholders pending cleanup; see `docs/whitepaper.md`
for the architecture-level reference even where the code is still landing.

## Authors

- TwelveLabs Solutions Architecture
- AWS Partner Solutions Architecture
