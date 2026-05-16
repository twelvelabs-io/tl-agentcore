# Building Agentic Highlight-Reel Pipelines on AWS

**An AgentCore × TwelveLabs reference architecture**

---

## 1 · Executive summary

The producer's "find me the highlights" task collapses from hours to
seconds when the agent can read the indexed library directly. Bedrock
AgentCore plus TwelveLabs Marengo and Pegasus is the AWS-native path to
that workflow without writing custom retrieval, custom ranking, or custom
generative-vision code.

A cache-first design pattern (per-asset profiles pre-built with Pegasus,
served from DynamoDB) closes a 4× latency gap vs. naïve live calls, and
is the single most important design decision for production use.

The architecture generalizes from highlights to sports recaps, ad
cutdowns, social shorts, and newsroom workflows with no agent-runtime
changes.

---

## 2 · The problem

### 2.1 What a producer actually does

Today, "build me a 60-second action highlight reel" is a multi-hour task:

1. Scrub the source footage (or trust someone else's notes).
2. Find candidate clips by memory, filename, or a brittle search.
3. Pick in/out points.
4. Stitch and review.
5. Iterate.

The shared property of every minute spent: the producer is the only
component in the system that has watched the video. Everything else
(filenames, transcripts, manual logs) is a proxy for what's actually on
screen.

### 2.2 Why classic AWS retrieval doesn't fit

Bedrock Knowledge Bases is the textbook answer for text retrieval. Video
has no peer primitive today. Naïve workarounds either:

- **OCR + transcript embed.** Lossy. A speeding car, a held look, a
  celebration: none of it is text. The retrieval recall is poor for
  precisely the moments producers care about.
- **CLIP-style frame embed.** Better, but missing temporal context. A
  highlight is *a sequence*, not a frame.

### 2.3 What "good" looks like

The agent should be able to ask the library: *"clips that look like a
celebration after a tense moment"*, and get clip-level results with start
and end timecodes, ranked by semantic match, with a one-line *why*. That
is what Marengo and Pegasus return.

---

## 3 · Architecture overview

### 3.1 Component map

```
        Browser (React + Vite)
          │  wss + Cognito JWT
          ▼
   CloudFront ──► API Gateway WebSocket ──► Chat λ (async self-invoke)
                                                  │
                                                  ▼  SigV4 InvokeAgentRuntime
                                          ┌────────────────────────────┐
                                          │  AgentCore Runtime         │
                                          │  Strands · Sonnet 4.6      │
                                          │  Graviton container (arm64)│
                                          └──────────┬─────────────────┘
                                                     │
            ┌────────────────────────┬───────────────┴────────────┐
            ▼ Tier-1 cache           ▼ Tier-2 live                ▼ Tier-3 orchestrated
        DynamoDB                   TwelveLabs API              TwelveLabs Jockey
        kb_cache table             /v1.3/search                /v1.3/responses
          (per-asset                /v1.3/analyze              (optional, comparison)
          profiles)
```

### 3.2 The three-tier tool design

The agent has access to three speed classes of tool. The system prompt
requires it to try the fastest tier first.

| Tier | Tool | p50 latency | When |
|---|---|---|---|
| 1 | `get_kb_overview` / `list_kb_assets` / `lookup_asset_profile` | <10 ms | Always start here on a known KS |
| 2 | `marengo_search` / `pegasus_analyze` / `list_tl_indexes` | 1–10 s | Cache miss, or needs in-clip timecodes |
| 3 | `ask_jockey` / `ask_followup` | 30 s–3 min | Open-ended Q&A across the corpus |

This mirrors how TwelveLabs Jockey itself works internally: a managed
agent that pre-computes a per-index "mini-ontology" so most questions are
answered from cache, with Marengo and Pegasus reached for only when the
cache is insufficient.

### 3.3 Why AgentCore (not Bedrock Agents)

| Concern | Bedrock Agents | AgentCore |
|---|---|---|
| Long-running multi-step tool calls | 60 s integration cap | Async invoke; multi-minute runs |
| Framework choice | Bedrock-flavored | Strands · LangGraph · CrewAI · any |
| Tool catalog | OpenAPI action groups | MCP via Gateway (or inline) |
| Identity | IAM only | Cognito JWT end-to-end through Gateway |
| Compute | Managed | Customer container (arm64 Graviton) |

For the highlight workflow specifically, a 6-beat rough cut routinely
needs 8–15 tool calls. The runtime needs to support a 2–3 minute envelope
without architectural gymnastics. AgentCore does; Bedrock Agents requires
async-self-invoke workarounds.

---

## 4 · The cache-first pattern

### 4.1 The naïve path is too slow

A 6-beat highlight reel built from `marengo_search` and `pegasus_analyze`
alone, across a 1,300-clip knowledge store, takes 3–5 minutes. That is
not interactive. Producers will not use it.

### 4.2 What Jockey does internally

TwelveLabs' own managed Jockey agent answers KB-level questions in under
two seconds because it pre-computes, at index time, a per-asset profile
capturing:

- One-line description
- Mood tags (tension, action, celebration, …)
- Visual style (handheld, wide, kinetic, …)
- Role hint (establishing, hero, b-roll, …)
- Subject and entity surface

…and stores it as a DDB row. The agent answers structural questions
("what's in this KB?", "find me action clips") without ever calling
Marengo or Pegasus at runtime.

### 4.3 The same pattern, ported to AgentCore

We ship the same ingestion as a script:

```
scripts/ingest_kb_cache.py ks_<id>
  ↓ list /v1.3/knowledge-stores/{ks}/items     (paginated)
  ↓ N × Pegasus /v1.3/analyze in parallel       (12 concurrent)
  ↓ N × DDB PutItem (per-asset)
  + 1 × DDB PutItem (corpus overview)
kb_cache table
```

Throughput: roughly 150 assets per minute. A 1,300-clip KB takes about
15 minutes to ingest.

Three agent tools read it back at runtime:

- `get_kb_overview(ks_id)`: corpus summary
- `list_kb_assets(ks_id, mood=…, role=…)`: filtered asset list
- `lookup_asset_profile(ks_id, asset_id)`: single-asset cached digest

### 4.4 Measured impact

| Same prompt, same KB (1,317 clips) | Latency |
|---|---|
| Live `marengo_search` + `pegasus_analyze` only | ~210 s |
| Cache-first (Tier 1 → Tier 2 fallback) | ~55 s |
| Jockey managed equivalent (reference) | ~50 s |

The cache-first agent ships at parity with the managed Jockey path. The
"AgentCore as compositional runtime" story is not a latency penalty; it
is latency parity, with the orchestration owned by the customer.

---

## 5 · The agent tool catalog

Detailed contract for each tool. Source of truth: `agent/tl_agentcore/agent.py`.

### 5.1 `marengo_search(index_id, query_text, knowledge_store_id?)`

Ranked clip-level retrieval. Always pass `knowledge_store_id` when known.
Marengo joins the cache and returns clips already enriched with
title, one_liner, mood_tags, and role_hint, eliminating most follow-up
Pegasus calls.

### 5.2 `pegasus_analyze(target, prompt)`

Single-video generation. Used when a cached `one_liner` does not answer
the beat (for example, *"what specifically happens at 0:32–0:38 in this
clip?"*).

### 5.3 `list_tl_indexes()`

Discovery. Skipped when the index is already in context.

### 5.4 `get_kb_overview` / `list_kb_assets` / `lookup_asset_profile`

The Tier-1 cache tools; see §4.

### 5.5 `ask_jockey(ks_id, prompt)`

Forwards to the managed Jockey orchestrator. Lives in the catalog so the
demo can show a side-by-side: same prompt, two runtimes, observable
divergence.

---

## 6 · Deployment recipe

Terraform-only deployment. Three modules under `infra/`:

1. `runtime.tf`: ECS Fargate task def, agent container, IAM role.
   arm64-only (Graviton).
2. `gateway.tf`: AgentCore Gateway, Cognito JWT authorizer, MCP target
   pointing at the runtime.
3. `dynamodb.tf`: `kb_cache` table, `pk = ks_<id>`, `sk = asset_<id>`
   or `sk = OVERVIEW`.

```bash
cd infra
terraform init
terraform apply -var="tl_api_key_secret=tl/api-key"
```

Build and push the agent container:

```bash
./build-agent.sh   # docker buildx build --platform linux/arm64 …
```

Ingest the cache for an existing KB:

```bash
python scripts/ingest_kb_cache.py ks_<id>
```

### 6.1 Hard-won gotchas

- **AgentCore Runtime is arm64-only.** linux/amd64 images get rejected at
  `CreateAgentRuntime` with `Architecture incompatible`.
- **API Gateway WebSocket has a 30 s integration cap.** Cannot be raised.
  Forces an async self-invoke pattern in the chat lambda.
- **Async lambda retry produces phantom duplicate runs.**
  `aws_lambda_function_event_invoke_config { maximum_retry_attempts = 0 }`
  is mandatory; otherwise every timeout fires the agent twice.
- **`runtime-session-id` must be ≥33 chars.** Short ids get rejected. Pad.
- **AWS provider ≥6.30** is required for `aws_bedrockagentcore_*` resources.
- **AgentCore Runtime → custom HTTP timeouts.** AWS SDK default
  socketTimeout (180 s) is below the 300 s lambda cap. Set NodeHttpHandler
  `socketTimeout: 280_000` explicitly.

---

## 7 · Generalization

The architecture is vertical-agnostic by design. To switch use cases,
only two things change:

1. **The system prompt:** what the agent is being asked to assemble
   (highlight reel → news recap → ad cutdown → channel block).
2. **The ingestion profile schema:** what gets cached per asset.

Worked examples:

- **Sports recaps.** Profile schema gains `play_type`, `momentum_shift`,
  `crowd_energy`. Prompt asks for narrative arc, not mood arc.
- **Social cutdowns.** Profile schema gains `vertical_safe`, `hook_window`,
  `caption_friendly`. Prompt biases short, kinetic, opening-strong.
- **Newsroom dossiers.** Profile schema gains `entity_appearances`,
  `quote_density`. Prompt asks for chronology and sources.
- **FAST channel programming.** Multi-prompt: rough-cut per show, then
  schedule. Adds an audience-intelligence DDB tool.

The TwelveLabs models (Marengo and Pegasus) do not change. The agent
runtime (AgentCore) does not change. Only the prompt and the cache schema.

---

## 8 · Reference implementation

The companion repository contains:

- `agent/`: Strands agent and tools (Python)
- `ui/`: React demo with live tool-trace visualization
- `infra/`: Terraform for one-command deployment
- `scripts/`: `ingest_kb_cache.py`
- `tests/`: end-to-end pipeline test

A reader can `terraform apply` and have a working endpoint in roughly 15
minutes, plus the cache-ingestion time for whatever KB they bring.

---

## 9 · Where this goes next

| Follow-on | Status |
|---|---|
| Pegasus 1.5 on Bedrock Marketplace, addendum on launch | pending Bedrock ETA |
| Sports-recap variant (white paper #2) | scoped |
| Newsroom dossier variant (white paper #3) | scoped |
| FAST-channel programming variant (white paper #4) | scoped |
| Open-source MCP server for TwelveLabs primitives | proposed to AWS |
| Typed `attach_video_knowledge` primitive in AgentCore | proposed to AWS |

---

*Authors: Leor Berezinski (TwelveLabs SA) · Adam (AWS SA) · James Wu
(TwelveLabs DevRel).*
