# Ingest Cost Estimate — tl-agentcore Demo Platform

A bottom-up cost model for ingesting a video corpus through the AWS-only
pipeline (`s3 copy → MediaConvert HLS → Bedrock Marengo embed →
Bedrock Pegasus profile → DynamoDB cache`).

All prices are Bedrock Marketplace and AWS list-price as of late-2025;
update the rate table if pricing shifts. Numbers are useful for sizing,
not invoice-exact.

---

## Per-asset / per-minute rate card

| Stage | Unit | Unit price (USD) | Notes |
|---|---|---:|---|
| Marengo Embed v3 (Bedrock) | per second of source video | $0.0006 | $0.036/min |
| Pegasus 1.2 Analyze input | per second of source video | $0.0008 | $0.048/min |
| Pegasus 1.2 Analyze output | per 1 k tokens | $0.015 | Profile ≈ 800–1,000 tokens / asset |
| Titan Multimodal Embed (image) | per image | $0.00006 | Thumbnail + entity-thumb |
| MediaConvert HLS, AVC HD | per minute of source | $0.017 | One 720 p rendition |
| MediaConvert HLS, AVC SD | per minute of source | $0.0075 | If downsampled |
| Claude Haiku 4.5 (event clustering) | per call | ~$0.001 | One pass per KB |
| S3 CopyObject (same-region, same-account) | per object | $0 | No transfer fees |
| S3 storage (clips bucket, Standard) | per GB-month | $0.023 | Cumulative |
| DynamoDB on-demand writes | per million | $1.25 | ~1 write per asset row |
| Cognito MAU | per active monthly user | $0.0055 | Per browser user |
| CloudFront egress | per GB out | $0.085 | Producer playback traffic |

**Derived single-asset costs** (assuming a 90-second, 4 Mbps SD clip):

| Stage | 90 s asset cost |
|---|---:|
| Marengo embed | $0.054 |
| Pegasus profile (input) | $0.072 |
| Pegasus profile (output, ~1 k tok) | $0.015 |
| MediaConvert HLS HD | $0.025 |
| Titan thumb | <$0.001 |
| **Per-asset total** | **≈ $0.17** |

A 60-minute game broadcast at the same rates costs about **$6.50**
(dominated by Pegasus + Marengo per-second charges).

---

## Estimated full ingest — the 5 demo KBs

Source corpora (counts and bytes from `aws s3 ls --recursive --summarize`,
duration estimated from total bytes assuming ~4 Mbps average bitrate, with
a ±25 % uncertainty bracket):

| # | KB | MP4 count | Total bytes | Est. minutes |
|---|---|---:|---:|---:|
| 1 | 🎬 Hollywood Trailers (`lior-test-files/trailers/`) | 1,379 | 15.8 GB | ~530 |
| 2 | 🎨 Blender Open Movies (`lior-test-files/BlenderOpenMovies/`, full-res) | 15 | 3.1 GB | ~70 |
| 3 | 🚲 Dirt and Determination dailies (`lior-test-files/Dirt and Determination dailies/`) | 245 | 39.6 GB | ~1,320 |
| 4 | 🍔 Takeout dailies (`lior-test-files/Takeout dailies/`) | 177 | 23.4 GB | ~780 |
| 5a | 🏈 Football game footage (`hudl-play-matching-026090552520/game-footage/`) | 6 | 0.7 GB | ~23 |
| 5b | 🏈 Football reference clips (`hudl-play-matching-026090552520/reference-clips/`) | 531 | 2.6 GB | ~87 |
| | **TOTAL** | **2,353** | **85.2 GB** | **≈ 2,810 (47 hours of source)** |

### Total cost rollup

| Stage | Quantity | Rate | Cost (USD) |
|---|---:|---:|---:|
| Marengo embed | 2,810 min | $0.036 | **$101** |
| Pegasus analyze (input) | 2,810 min | $0.048 | **$135** |
| Pegasus analyze (output tokens, ~1k per asset) | 2,353 k tokens | $0.015 / k | **$35** |
| MediaConvert HLS HD | 2,810 min | $0.017 | **$48** |
| Titan thumb embeds (one per asset) | 2,353 | $0.00006 | **$0.14** |
| Claude haiku (event clustering) | 5 calls | ~$0.001 | **<$0.01** |
| DynamoDB writes (assets + kb_cache rows) | ~9,000 | $0.00000125 | **<$0.02** |
| S3 storage carry-cost (clips + HLS bundles, ~110 GB after transcode, 1 month) | 110 GB·mo | $0.023 | **$2.53** |
| Misc (S3 transitions, CloudWatch logs, KMS) | — | — | **~$1** |
| | | | |
| **Total ingest cost** | | | **≈ $322** |
| ±25 % bracket (driven by bitrate uncertainty) | | | **$240 – $405** |

Pegasus profile work is roughly half the bill. The dailies and game-footage
KBs dominate per-asset cost because their clips are longer; the trailer KB
has the most rows but the lowest per-row spend.

### Wall-clock runtime

End-to-end the bottleneck is Pegasus (lower rate limit than Marengo):

| Stage | Serial | Realistic parallel |
|---|---:|---:|
| S3 CopyObject (2,353 objects, same-region) | minutes | <5 min |
| MediaConvert HLS (per-job concurrency: tens) | hours | ~30 min |
| Marengo async embed (Bedrock async-invoke quota ≈ 20 in-flight) | ~24 h | ~3 h |
| Pegasus profile (TPM-limited, ~5 concurrent realistic) | ~24 h | ~6 h |

**Allow ~6–10 h of wall-clock from kick-off until every KB is fully ready**
(HLS, embeddings, profile, entity graph). The Library tab lights up
incrementally; users can play assets as soon as MediaConvert + Marengo
finish each one.

---

## Steady-state operating cost (after ingest)

What it costs per month to leave the demo running once it's loaded.

### Fixed infrastructure (idle)

| Resource | Monthly $ | Notes |
|---|---:|---|
| AgentCore Runtime, idle | $0 | Pay-per-invocation; no idle minute charge |
| Lambdas, idle | $0 | Pay-per-request |
| API Gateway HTTP API, idle | $0 | Per-million-requests pricing |
| API Gateway WebSocket, idle | $0 | Per-message pricing |
| DynamoDB on-demand (5 tables, no traffic) | <$1 | Storage only |
| S3 storage (≈ 110 GB clips + 50 GB HLS) | ~$3.50 | Standard tier |
| S3 Vectors index storage | ~$0.50 | Tiny — single-digit MB across all rows |
| CloudFront distribution, no traffic | $0 | No request fee |
| Cognito User Pool, ≤ 10 users | <$0.10 | $0.0055 × MAU |
| SageMaker Async Endpoint, scale-to-zero | $0 | Scales to 0 instances when idle |
| **Fixed monthly floor** | **≈ $5** | |

### Per-session variable cost

Numbers for a single producer session running one Rough Cut turn end-to-end.
Assumes the user fires one 6-beat brief, gets an EDL back, then runs two
follow-up turns.

| Stage (per session) | Cost |
|---|---:|
| AgentCore Runtime — 60–120 s active | ~$0.04 |
| Bedrock Sonnet 4.6 — ~10 k input + 4 k output tokens per turn × 3 turns | ~$0.30 |
| Marengo text embed — 6 beat phrases × 3 turns | ~$0.006 |
| S3 Vectors QueryVectors — 18 calls (3 modality × 6 beats) | <$0.001 |
| DynamoDB Tier-1 cache reads — ~20 GetItem calls | <$0.001 |
| Pegasus follow-up (if user asks for grounded analysis) | ~$0.10 |
| MediaConvert preview render (one /stitch invocation, 30-second cut) | ~$0.01 |
| CloudFront egress for clip playback (~50 MB) | <$0.01 |
| **Per-session total** | **≈ $0.40 – $0.50** |

A single user running 20 sessions a day across a month ≈ $250–300/mo,
dominated by Sonnet reasoning tokens.

### Optional offline workloads

| Workload | When it costs | Cost |
|---|---|---:|
| Entity Re-ID pipeline (SageMaker Async Endpoint, g5.xlarge) | When operator triggers Step Functions per KS | ~$1.30/hr × ~30 min per 100 assets = ~$0.65 per 100 assets |
| Re-running Pegasus profile after a model upgrade | Per-asset Pegasus rate above | ~$0.10 per asset |
| Event clustering re-run | Per Claude haiku call | <$0.01 per KB |

---

## Optimization levers, in order of impact

1. **Skip Pegasus on long-form footage.** Pegasus on 60-min game broadcasts
   is the single most expensive operation. If a KB only needs `vector_search`
   (clips ranking) and not `lookup_asset_profile` (prose grounding),
   skipping the profile step drops cost by 50 %.
2. **Downsample to SD for MediaConvert.** HD AVC is $0.017/min; SD AVC is
   $0.0075/min. For a B-roll / preview-only library, SD is fine; cuts the
   MediaConvert line item in half.
3. **Pre-trim long sources.** Run ffmpeg upstream to extract 30–120 s
   highlight segments instead of profiling whole games — same downstream
   utility, ~⅒ the Pegasus + Marengo spend.
4. **Tier-1 cache populates lazily.** If most users only ever query a
   subset of the corpus, profile that subset and lazy-profile the rest on
   first access — pay for what you use.
5. **Use Marengo's per-modality opt-out.** A music-video corpus doesn't
   need transcription embeddings; a silent stock-footage corpus doesn't
   need audio. Each modality skipped drops Marengo by ⅓.

---

## What this estimate does *not* include

- **Egress to / from TwelveLabs SaaS.** The AWS-only build has none of
  that — everything is Bedrock Marketplace billed through the customer's
  AWS account.
- **Cognito Advanced Security**, GuardDuty, or any other AWS security
  add-on. The reference deploy uses the free tier.
- **CodeBuild** for container builds (gdino + agent). Free tier covers
  the demo cadence; budget $5/mo if pushing daily.
- **Marketplace one-time agreement fees** (some Bedrock Marketplace
  models charge a small per-region subscription on first use). Watch for
  these on the AWS bill the first time the runtime invokes a model in a
  new region.

---

## Methodology notes

- Bedrock model rates pulled from the public Bedrock Marketplace listings
  for TwelveLabs Marengo Embed v3 and Pegasus 1.2 (us-east-1 region).
  Verify against the live console before billing planning.
- Duration estimates derive from total bytes ÷ assumed 4 Mbps bitrate.
  Real corpora vary 1.5–8 Mbps depending on encode; ±25 % bracket
  reflects that.
- MediaConvert pricing is the on-demand rate; reserved capacity is
  available at ~30 % discount if running heavy steady-state transcode.
- Token output for Pegasus profiles is calibrated against the structured
  JSON profile `ingest_kb_cache.py` emits (~800 tokens average).
- The runtime per-session estimate assumes Anthropic Claude Sonnet 4.6
  Bedrock pricing: $3/Mtok input, $15/Mtok output (October 2025 list).
