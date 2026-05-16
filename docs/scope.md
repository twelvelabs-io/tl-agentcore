# Scope & requirements: *please react on this doc first*

Companion to [`whitepaper.md`](whitepaper.md). Lock the scope here before
we invest in long-form prose in the paper itself.

> **How to review:** add a `✅` next to lines we want in v1; add `⏭️` to
> defer; comment with anything missing.

---

## Audience

- AWS Solutions Architects, Bedrock / AgentCore field teams
- Media-and-entertainment developers and CTOs evaluating agentic video
  workflows on AWS
- *Not* end-users (producers, editors). They are the persona we **build
  for**, not the persona we **write for**.

## Use case in scope (v1)

| # | Capability | In v1? |
|---|---|:-:|
| R1 | Natural-language prompt → multi-clip rough-cut / highlight reel plan (EDL) | ☐ |
| R2 | Cache-first retrieval (pre-built per-asset profiles in DDB) | ☐ |
| R3 | Marengo semantic clip search as Tier-2 fallback | ☐ |
| R4 | Pegasus generative analysis as Tier-3 fallback | ☐ |
| R5 | Live "tool trace" visualization (architecture diagram lighting up per node) | ☐ |
| R6 | HLS back-to-back playback of the produced reel | ☐ |
| R7 | EDL export (XML / CSV / FCP7) for NLE handoff | ☐ |
| R8 | Pegasus 1.5 on Bedrock Marketplace when GA (today: API + agent wrapper) | ☐ |
| R9 | Marengo-ranked alternates per clip with one-click producer swap | ☐ |

## Generalization promises (architectural)

- ☐ Same shape for **Pegasus 1.5 → 1.7 → 2.0** as they ship.
- ☐ Same shape for **Marengo 3.0 → 3.5**.
- ☐ Same shape for any **reasoning model** (Claude Sonnet / Haiku / Opus,
  Llama, Nova) the customer prefers; we recommend, don't dictate.
- ☐ Same shape for **adjacent verticals**: sports recaps, social cutdowns,
  newsroom dossiers, FAST channels, ad-creative selects. v1 picks one
  vertical (highlights) but the diagrams should obviously stretch.

## Out of scope (v1, by design)

- Live ingest / encoding (`MediaLive`, `MediaConvert`); covered separately.
- Rights / clearance enforcement: referenced as a tool boundary, not
  implemented end-to-end (TwelveLabs has a separate rights-DAM white paper).
- Audience-intelligence reasoning (Nielsen-style segmentation); referenced
  as a future tool, not in the v1 demo.
- Channel programming (FAST/AVOD); the highlight reel is the leaf, and
  channels are a follow-on white paper.

## Open questions to settle in the next sync

1. **Pegasus 1.5 timing.** Bedrock Marketplace ETA? If <8 weeks, do we hold
   publication; if not, ship with API-direct and add a "Now on Bedrock"
   addendum on launch day.
2. **Joint AWS technical-blog companion**: short version (~1,500 words) on
   the AWS Machine Learning blog vs. the long-form white paper here.
   James / Adam to confirm MNE intake path.
3. **Hosted demo URL.** Is the existing CloudFront URL share-able with the
   whitepaper, or do we stand up a separate "anonymous reviewer" instance?
4. **Customer pull-quote.** Can WBD comment on record (any tier of attribution)?

---

*Owner: Leor Berezinski (TwelveLabs SA) · Adam (AWS SA) · James Wu
(TwelveLabs DevRel). Last touched: 2026-05-15.*
