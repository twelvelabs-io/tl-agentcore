# EDL-quality eval harness

A reference-free (and, when curated, reference-aware) evaluation harness for
the rough-cut / highlight-reel EDL that `agent/tl_agentcore/agent.py`
emits inside `<plan>...</plan>` tags.

## Why this exists

Prompt / routing / anchor changes to the agent land all the time. Without
a harness, "did that make the output better or worse?" devolves into eyeballing
a couple of hand-run briefs. This folder is the thing you point at before and
after a change to get a comparable number.

Scope is deliberately narrow:

- **In:** EDL structural correctness (plan parses? duration matches brief?
  scene / clip counts in band?) and, when a curated reference EDL exists,
  asset-overlap vs. that reference.
- **Out of scope (for now):** judge-quality (that's live in
  `agent/tl_agentcore/scoring/`), end-to-end human preference scoring, A/B
  weighting across modalities.

## Running

```bash
# From repo root, with the agent env active:
cd agent && uv venv && . .venv/bin/activate && uv pip install -r requirements.txt && cd ..
python eval/edl-quality/bin/run_eval.py eval/edl-quality/briefs/01-sample.json

# Or glob a whole suite:
python eval/edl-quality/bin/run_eval.py 'eval/edl-quality/briefs/*.json'
```

(Mirrors the sibling `eval/entity-reid/bin/run_eval.py` convention — a plain
script, not a module. The folder name has a hyphen for consistency with the
rest of the repo, which `python -m` wouldn't accept.)

Reports land in `eval/edl-quality/reports/<ts>.{json,md}`. The JSON is the
authoritative artifact — diff two runs' JSON files to see what changed. The
Markdown is for humans skimming after a run.

## Brief schema

```json
{
  "id":                 "01-sample",
  "knowledge_store_id": "ks_...",
  "brief":              "Build a 30 second action highlight reel ...",
  "constraints": {
    "target_duration_s":     30,
    "min_scenes":            2,
    "max_scenes":            6,
    "min_clip_duration_s":   3,
    "max_clip_duration_s":  15
  },
  "reference": null
}
```

- `knowledge_store_id` must exist in your AWS account; the harness invokes
  the agent against the live KS. Seed KS with `scripts/ingest_vectors.py`.
- `constraints` are the structural bands the reference-free scorer checks.
  Leave fields out to skip the corresponding check.
- `reference` is optional. Fill it with a human-produced plan matching the
  agent's own `<plan>` schema (`scenes[].clips[]` with `asset_id` + `start_time` / `end_time`)
  to activate the reference-aware scorer (asset recall / precision / Jaccard,
  duration delta, scene-count delta).

## Metrics

### Reference-free (always run)

| Metric | Meaning |
|---|---|
| `plan_present` | `<plan>` block existed and parsed as JSON |
| `plan_scenes` / `plan_clips` | Counts straight from the parsed plan |
| `plan_duration_s` | Sum of `(end - start)` across all clips |
| `duration_abs_delta_s` | `|plan_duration_s − target_duration_s|` |
| `duration_within_10pct` | Delta ≤ 10 % of target |
| `scene_count_in_band` | `min_scenes ≤ plan_scenes ≤ max_scenes` |
| `clips_outside_duration_band` | Count of clips with `end - start` outside `[min_clip_duration_s, max_clip_duration_s]` |
| `all_clips_in_band` | Convenience: the above == 0 |

### Reference-aware (only when `brief.reference` is set)

| Metric | Meaning |
|---|---|
| `asset_recall` | Agent ∩ Ref / Ref |
| `asset_precision` | Agent ∩ Ref / Agent |
| `asset_jaccard` | Agent ∩ Ref / (Agent ∪ Ref) |
| `duration_delta_s` / `duration_delta_pct` | Agent − Ref total duration |
| `scene_count_delta` | Agent − Ref scene count |

## Run modes

- `run_local` (shipped) — imports `tl_agentcore.agent.build_agent` and
  invokes in-process. Fast, no network, no auth, but doesn't exercise the
  runtime wrapper (preseed, ReWOO router, judges). Fine for prompt-engineering
  iteration where only the ReAct body matters.
- `run_deployed` (stub) — opens a WS to the deployed AgentCore Runtime, drives
  it with the brief, reads final text. The "real" path. Needs the Cognito test
  user from `ui/e2e/README.md`. Follow-up PR.

## Adding briefs

Drop a new `briefs/NN-foo.json`. The runner glob-expands any path you pass, so
`briefs/*.json` picks it up. Number briefs to keep ordering stable — same
convention as the Playwright E2E suite.

## Non-goals

- This harness is not a replacement for the inline agent judges — they score
  individual tool invocations in real traffic; this scores the whole EDL.
- The reference-free band checks are structural, not quality. A plan can
  satisfy every band and still be a bad cut; conversely, a brilliant plan
  that overshoots duration will be flagged. Treat bands as regression tripwires,
  not grades.
