# Building Agentic Highlight-Reel Pipelines on AWS

**An AgentCore × TwelveLabs reference architecture**

> **Status:** Skeleton draft — May 14, 2026. Shared for scope alignment and
> review. Comment freely. Page 1 is the **scope / requirements check-box
> page**; everything after is a placeholder structure to react against.

---

## 0 · Scope & requirements — *please react on this page first*

> **Goal of this section:** lock the scope before we invest in long-form
> prose. Add a `✅` next to lines we want in v1; add `⏭️` to defer; comment
> with anything missing.

### Audience

- AWS Solutions Architects, Bedrock / AgentCore field teams
- Media-and-entertainment developers and CTOs evaluating agentic video
  workflows on AWS
- *Not* end-users (producers, editors) — they are the persona we **build
  for**, not the persona we **write for**.

### Use case in scope (v1)

| # | Capability | In v1? |
|---|---|:-:|
| R1 | Natural-language prompt → multi-clip rough-cut / highlight reel plan (EDL) | ☐ |
| R2 | Cache-first retrieval (pre-built per-asset profiles in DDB) | ☐ |
| R3 | Marengo semantic clip search as Tier-2 fallback | ☐ |
| R4 | Pegasus generative analysis as Tier-3 fallback | ☐ |
| R5 | Live "tool trace" visualization (architecture diagram lighting up per node) | ☐ |
| R6 | Side-by-side comparison vs. a managed Jockey call (same prompt, same KB) | ☐ |
| R7 | HLS back-to-back playback of the produced reel | ☐ |
| R8 | EDL export (XML / CSV / FCP7) for NLE handoff | ☐ |
| R9 | Pegasus 1.5 on Bedrock Marketplace when GA (today: API + agent wrapper) | ☐ |

### Generalization promises (architectural)

- ☐ Same shape for **Pegasus 1.5 → 1.7 → 2.0** as they ship.
- ☐ Same shape for **Marengo 3.0 → 3.5**.
- ☐ Same shape for any **reasoning model** (Claude Sonnet / Haiku / Opus,
  Llama, Nova) the customer prefers — we recommend, don't dictate.
- ☐ Same shape for **adjacent verticals**: sports recaps, social cutdowns,
  newsroom dossiers, FAST channels, ad-creative selects. v1 picks one
  vertical (highlights) but the diagrams should obviously stretch.

### Out of scope (v1, by design)

- Live ingest / encoding (`MediaLive`, `MediaConvert`) — covered separately.
- Rights / clearance enforcement — referenced as a tool boundary, not
  implemented end-to-end (TwelveLabs has a separate rights-DAM white paper).
- Audience-intelligence reasoning (Nielsen-style segmentation) — referenced
  as a future tool, not in the v1 demo.
- Channel programming (FAST/AVOD) — the highlight reel is the leaf; channels
  are a follow-on white paper.

### Open questions to settle in the next sync

1. **Pegasus 1.5 timing.** Bedrock Marketplace ETA? If <8 weeks, do we hold
   publication; if not, ship with API-direct and add a "Now on Bedrock"
   addendum on launch day.
2. **Joint AWS technical-blog companion** — short version (~1,500 words) on
   the AWS Machine Learning blog vs. the long-form white paper here.
   James / Adam to confirm MNE intake path.
3. **Hosted demo URL** — is the existing CloudFront URL share-able with the
   whitepaper, or do we stand up a separate "anonymous reviewer" instance?
4. **Customer pull-quote.** Can WBD comment on record (any tier of attribution)?

---

## 1 · Executive summary

*One-page hook. To be written last so it reflects the final body.*

Placeholder beats:

- The producer's "find me the highlights" task collapses from hours to
  seconds when the agent can read the indexed library directly.
- Bedrock AgentCore + TwelveLabs Marengo/Pegasus is the AWS-native path to
  that workflow without writing custom retrieval, custom ranking, or custom
  generative-vision code.
- A cache-first design pattern (per-asset profiles pre-built with Pegasus,
  served from DynamoDB) closes a 4× latency gap vs. naïve live calls — and
  is the **single most important design decision** for production use.
- The architecture generalizes from highlights to sports recaps, ad cutdowns,
  social shorts, and newsroom workflows with no agent-runtime changes.

---

## 2 · The problem

### 2.1 What a producer actually does

Today, "build me a 60-second action highlight reel" is a multi-hour task:

1. Scrub the source footage (or trust someone else's notes).
2. Find candidate clips by memory, filename, or a brittle search.
3. Pick in/out points.
4. Stitch and review.
5. Iterate.

The shared property of every minute spent: **the producer is the only
component in the system that has watched the video**. Everything else —
filenames, transcripts, manual logs — is a proxy for what's actually on
screen.

### 2.2 Why classic AWS retrieval doesn't fit

Bedrock Knowledge Bases is the textbook answer for text retrieval. Video
has no peer primitive today. Naïve workarounds either:

- **OCR + transcript embed.** Lossy. A speeding car, a held look, a
  celebration — none of it is text. The retrieval recall is poor for
  precisely the moments producers care about.
- **CLIP-style frame embed.** Better, but missing temporal context. A
  highlight is *a sequence*, not a frame.

### 2.3 What "good" looks like

The agent should be able to ask the library: *"clips that look like a
celebration after a tense moment"* — and get clip-level results with start
and end timecodes, ranked by semantic match, with a one-line *why*. That's
exactly what Marengo + Pegasus return.

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

*[Diagram to be redrawn in draw.io / Excalidraw for the published version.
The ASCII version above is what we'll iterate against in review.]*

### 3.2 The three-tier tool design

The agent has access to three speed classes of tool. The system prompt
**requires it to try the fastest tier first**.

| Tier | Tool | p50 latency | When |
|---|---|---|---|
| 1 | `get_kb_overview` / `list_kb_assets` / `lookup_asset_profile` | <10 ms | Always start here on a known KS |
| 2 | `marengo_search` / `pegasus_analyze` / `list_tl_indexes` | 1–10 s | Cache miss, or needs in-clip timecodes |
| 3 | `ask_jockey` / `ask_followup` | 30 s–3 min | Open-ended Q&A across the corpus |

This mirrors how TwelveLabs Jockey itself works internally (see
`JOCKEY_INTERNALS.md` reference) — a managed agent that pre-computes a
per-index "mini-ontology" so most questions are answered from cache, with
Marengo/Pegasus reached for only when the cache is insufficient.

### 3.3 Why AgentCore (not Bedrock Agents)

| Concern | Bedrock Agents | AgentCore |
|---|---|---|
| Long-running multi-step tool calls | 60 s integration cap | Async invoke; multi-minute runs |
| Framework choice | Bedrock-flavored | Strands · LangGraph · CrewAI · any |
| Tool catalog | OpenAPI action groups | MCP via Gateway (or inline) |
| Identity | IAM only | Cognito JWT end-to-end through Gateway |
| Compute | Managed | Customer container (arm64 Graviton) |

For the highlight workflow specifically: a 6-beat rough cut routinely
needs 8–15 tool calls. The runtime needs to support a 2-3 minute envelope
without architectural gymnastics. AgentCore does; Bedrock Agents requires
async-self-invoke workarounds.

---

## 4 · The cache-first pattern — *the most important section*

> If readers take one thing away from this paper, it should be this section.

### 4.1 The naïve path is too slow

A 6-beat highlight reel built from `marengo_search` + `pegasus_analyze`
alone, across a 1,300-clip knowledge store, takes **3–5 minutes**. That's
not interactive. Producers won't use it.

### 4.2 What Jockey does internally

TwelveLabs' own managed Jockey agent answers KB-level questions in <2 s
because it pre-computes — at index time — a per-asset "profile" capturing:

- One-line description
- Mood tags (tension, action, celebration, …)
- Visual style (handheld, wide, kinetic, …)
- Role hint (establishing, hero, b-roll, …)
- Subject / entity surface

…and stores it as a DDB row. The agent answers structural questions
("what's in this KB?", "find me action clips") **without ever calling
Marengo or Pegasus at runtime**.

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

Throughput: ~150 assets/min. A 1,300-clip KB takes ~15 min to ingest.

Three new agent tools read it back at runtime:

- `get_kb_overview(ks_id)` — corpus summary
- `list_kb_assets(ks_id, mood=…, role=…)` — filtered asset list
- `lookup_asset_profile(ks_id, asset_id)` — single-asset cached digest

### 4.4 Measured impact

| Same prompt, same KB (1,317 clips) | Latency |
|---|---|
| Live `marengo_search` + `pegasus_analyze` only | ~210 s |
| Cache-first (Tier 1 → Tier 2 fallback) | ~55 s |
| Jockey managed equivalent (reference) | ~50 s |

*[Numbers from internal lab. Will re-measure for the final paper against
the public version of the demo.]*

The cache-first agent ships at parity with the managed Jockey path. The
"AgentCore as compositional runtime" story isn't a latency penalty — it's
a latency parity, with the orchestration owned by the customer.

---

## 5 · The agent tool catalog (v1)

Detailed contract for each tool. *Source of truth:
`agent/tl_agentcore/agent.py`.*

### 5.1 `marengo_search(index_id, query_text, knowledge_store_id?)`

Ranked clip-level retrieval. Always pass `knowledge_store_id` when known —
Marengo joins the cache and returns clips already enriched with
title / one_liner / mood_tags / role_hint, eliminating most follow-up
Pegasus calls.

*[Request / response example tables — TBD in v2.]*

### 5.2 `pegasus_analyze(target, prompt)`

Single-video generation. Used when a cached `one_liner` doesn't answer the
beat (e.g. *"what specifically happens at 0:32-0:38 in this clip?"*).

### 5.3 `list_tl_indexes()`

Discovery. Skipped when the index is already in context.

### 5.4 `get_kb_overview` / `list_kb_assets` / `lookup_asset_profile`

The Tier-1 cache tools — see §4.

### 5.5 `ask_jockey(ks_id, prompt)` *(comparison only)*

Forwards to the managed Jockey orchestrator. Lives in the catalog so the
demo can show a side-by-side: same prompt, two runtimes, observable
divergence.

---

## 6 · Deployment recipe

Terraform-only deployment. Three modules under `infra/`:

1. **`runtime.tf`** — ECS Fargate task def, agent container, IAM role.
   arm64-only (Graviton).
2. **`gateway.tf`** — AgentCore Gateway, Cognito JWT authorizer, MCP target
   pointing at the runtime.
3. **`dynamodb.tf`** — `kb_cache` table, `pk = ks_<id>`, `sk = asset_<id>`
   or `sk = OVERVIEW`.

```bash
cd infra
terraform init
terraform apply -var="tl_api_key_secret=tl/api-key"
```

Build + push the agent container:

```bash
./build-agent.sh   # docker buildx build --platform linux/arm64 …
```

Ingest the cache for an existing KB:

```bash
python scripts/ingest_kb_cache.py ks_<id>
```

### 6.1 Hard-won gotchas

*Excerpt — full list in `agent/RUNBOOK.md`.*

- **AgentCore Runtime is arm64-only.** linux/amd64 images get rejected at
  `CreateAgentRuntime` with `Architecture incompatible`.
- **API Gateway WebSocket has a 30 s integration cap.** Cannot be raised.
  Forces an async self-invoke pattern in the chat lambda.
- **Async lambda retry produces phantom duplicate runs.**
  `aws_lambda_function_event_invoke_config { maximum_retry_attempts = 0 }`
  is mandatory; otherwise every timeout fires the agent twice.
- **`runtime-session-id` must be ≥33 chars.** Short ids get rejected. Pad.
- **AWS provider ≥6.30** required for `aws_bedrockagentcore_*` resources.
- **AgentCore Runtime → custom HTTP timeouts.** AWS SDK default
  socketTimeout (180 s) is below the 300 s lambda cap. Set NodeHttpHandler
  `socketTimeout: 280_000` explicitly.

---

## 7 · Generalization

The architecture is **vertical-agnostic** by design. To switch use cases,
only two things change:

1. **The system prompt** — what the agent is being asked to assemble
   (highlight reel → news recap → ad cutdown → channel block).
2. **The ingestion profile schema** — what gets cached per asset.

Worked examples (placeholders — flesh out one per follow-on paper):

- **Sports recaps.** Profile schema gains `play_type`, `momentum_shift`,
  `crowd_energy`. Prompt asks for narrative arc, not mood arc.
- **Social cutdowns.** Profile schema gains `vertical_safe`, `hook_window`,
  `caption_friendly`. Prompt biases short, kinetic, opening-strong.
- **Newsroom dossiers.** Profile schema gains `entity_appearances`,
  `quote_density`. Prompt asks for chronology + sources.
- **FAST channel programming.** Multi-prompt: rough-cut per show, then
  schedule. Adds an audience-intelligence DDB tool.

The TwelveLabs models (Marengo / Pegasus) don't change. The agent
runtime (AgentCore) doesn't change. Only the prompt and the cache schema.

---

## 8 · Reference implementation

The companion repository at `github.com/twelvelabs/tl-agentcore` *(to be
created — currently `~/Dev/tl-agentcore` local)* contains:

- `agent/` — Strands agent + tools (Python)
- `ui/` — React demo with live tool-trace visualization
- `infra/` — Terraform for one-command deployment
- `scripts/` — `ingest_kb_cache.py`
- `tests/` — end-to-end pipeline test

The reader can `terraform apply` and have a working endpoint in ~15
minutes (plus the cache-ingestion time for whatever KB they bring).

---

## 9 · Where this goes next

| Follow-on | Status |
|---|---|
| Pegasus 1.5 on Bedrock Marketplace — addendum on launch | pending Bedrock ETA |
| Sports-recap variant (white paper #2) | scoped |
| Newsroom dossier variant (white paper #3) | scoped |
| FAST-channel programming variant (white paper #4) | scoped |
| Open-source MCP server for TwelveLabs primitives | proposed to AWS |
| Typed `attach_video_knowledge` primitive in AgentCore | proposed to AWS |

---

## Appendix A — Internal references (not for publication)

These exist in the source repo and inform the paper but should be stripped
before external distribution:

- `JOCKEY_INTERNALS.md` — TL's managed Jockey agent internals; source of
  the cache-first pattern.
- `AWS_CONVERSATION.md` — original architecture-discussion brief; source
  of §3, §4, §6.
- Lab demo flow notes (May 14, 2026 sync transcript).

---

## Appendix B — Open questions for review

1. Should §4 (cache-first pattern) be its own short blog post AND a
   chapter in this paper, or just the chapter?
2. How explicit do we get about Jockey-vs-agent latency parity? The
   number is favorable; the framing could read as competitive.
3. Reviewer process: GitHub PR comments on `docs/whitepaper.md`, or
   Google Docs round-trip? *Meeting agreed Google Drive — confirm.*
4. Customer co-author / pull-quote — WBD? Other?

---

*Draft owner: Leor Berezinski (TwelveLabs SA) · Adam (AWS SA) ·
James Wu (TwelveLabs DevRel).
Next review: scheduled-week sync, May 28, 2026.*
