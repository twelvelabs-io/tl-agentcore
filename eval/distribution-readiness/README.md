# Distribution-readiness eval harness

A reference-free (and, when curated, reference-aware) evaluation harness for
the Distribution-Readiness `<distribution_card>` payload that
`agent/tl_agentcore/agent.py` emits in Distribution-Readiness mode.

Mirrors the sibling `eval/edl-quality/` harness in shape and conventions —
the two share the same CLI entry pattern, the same reports/ layout, and the
same split between pure scorer / impure runner / human-skim report writer.

## Why this exists

The Distribution-Readiness recipe (territory → audience_fit → rights_check →
policy requirements → corpus inventory → gap report) composes three parallel
plugin tools, a per-candidate `lookup_asset_profile`, and a structured JSON
emit — all of which can regress silently when the SYSTEM_PROMPT, the plugin
schemas, or the gateway credential-provider configuration change. This
harness is the thing you point at before and after each of those edits.

Scope:

- **In:** card structural correctness (card parses? territory matches brief?
  summary counts align with assets[]? gap computation is sound?), audience
  presence, policy presence, and — when a curated reference card exists —
  asset / requirement overlap vs. that reference.
- **Out of scope (for now):** judging whether the agent picked the *right*
  audience segment, A/B-ing scoring formulas, deep validation of rights-window
  arithmetic.

## Running

```bash
# From repo root, with the agent env active:
cd agent && uv venv && . .venv/bin/activate && uv pip install -r requirements.txt && cd ..
python eval/distribution-readiness/bin/run_eval.py eval/distribution-readiness/briefs/01-sample.json

# Or glob a whole suite:
python eval/distribution-readiness/bin/run_eval.py 'eval/distribution-readiness/briefs/*.json'
```

Reports land in `eval/distribution-readiness/reports/<ts>.{json,md}`. Diff two
runs' JSONs to see what changed; the Markdown is for humans skimming after.

## Brief schema

```json
{
  "id":                 "01-sample",
  "knowledge_store_id": "ks_...",
  "brief":              "Can I distribute to Germany? Give me a readiness report.",
  "expected": {
    "territory":                   "DE",
    "expect_policy":               true,
    "expect_audience_fit":         true,
    "min_policy_requirements":     2,
    "max_elapsed_ms":              90000
  },
  "reference": null
}
```

- `knowledge_store_id` must exist in your AWS account; the harness invokes
  the agent against the live KS. Seed with `scripts/ingest_vectors.py`.
- `expected` are the structural bands the reference-free scorer checks. Each
  field is independently optional — leave it out to skip that check.
- `reference` is optional. Fill it with a human-curated card matching the
  agent's own `<distribution_card>` shape to activate the reference-aware
  scorer (asset / requirement overlap, ready-count delta).

## Metrics

### Reference-free (always run)

| Metric | Meaning |
|---|---|
| `card_present` | `<distribution_card>` block existed and parsed as JSON |
| `card_valid_shape` | Required top-level fields all present |
| `territory_matches_brief` | `card.territory == expected.territory` (uppercase match) |
| `n_assets` | `len(card.assets)` |
| `n_ready` / `n_blocked` | Counts straight from the card |
| `summary_counts_consistent` | `ready_count + blocked_count == n_assets` AND counts match `assets[*].ready` |
| `gap_computation_sound` | For every asset, `missing == requirements − have` as a set difference |
| `policy_requirements_present` | `len(policy.requirements) >= expected.min_policy_requirements` |
| `has_audience_fit` | `len(audience_fit.candidates) > 0` |
| `has_cleared_assets` | `n_assets > 0` |
| `elapsed_within_cap` | `run.elapsed_ms <= expected.max_elapsed_ms` |

### Reference-aware (only when `brief.reference` is set)

| Metric | Meaning |
|---|---|
| `asset_recall` | Agent ∩ Ref / Ref over `asset_id` sets |
| `asset_precision` | Agent ∩ Ref / Agent over `asset_id` sets |
| `asset_jaccard` | Agent ∩ Ref / (Agent ∪ Ref) over `asset_id` sets |
| `requirements_jaccard` | Same, over `policy.requirements` |
| `ready_count_delta` | `agent.ready_count - ref.ready_count` |
| `territory_match` | `agent.territory == ref.territory` |

## Run modes

- `run_local` (shipped) — imports `tl_agentcore.agent.build_agent` and invokes
  in-process. Fast, no network, no auth. Does NOT exercise the deployed Gateway
  plugin surface — the agent falls back to its in-process `lookup_rights` etc.
  if the gateway isn't reachable, so a `run_local` score tells you prompt /
  classification quality but not whether the Gateway plumbing holds.
- `run_deployed` (stub) — opens a WS to the deployed AgentCore Runtime. The
  real end-to-end path. Needs the Cognito test user from `ui/e2e/README.md`.
  Follow-up PR, same pattern as `eval/edl-quality/`.

## Adding briefs

Drop a new `briefs/NN-foo.json`. The runner glob-expands any path you pass, so
`briefs/*.json` picks it up. Number briefs to keep ordering stable — same
convention as the Playwright E2E suite and the sibling EDL eval.

## Non-goals

- This harness isn't a replacement for the inline agent judges — they score
  individual tool invocations in real traffic; this scores the whole card.
- The structural checks are structural, not quality. A card can satisfy every
  band and still get the top-ranked audience segment subtly wrong; conversely,
  an insightful card that overshoots its elapsed-time budget will be flagged.
  Treat bands as regression tripwires, not grades.
