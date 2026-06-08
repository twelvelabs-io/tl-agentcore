# Comprehensive E2E suite

Standalone Playwright suite that covers all four UI tabs end-to-end PLUS uses
a Bedrock-Claude reasoner to grade rough-cut output quality semantically.
Lives in `ui/e2e/comprehensive/` and runs alongside (not instead of) the
curated `01-…`–`32-…` regression specs.

## What's covered

| Spec | What it tests |
|---|---|
| `masthead.spec.ts` | Tab nav, KS picker, user dropdown, Settings modal |
| `cut-types.spec.ts` | All 6 brief templates — structural checks + Bedrock semantic grade |
| `followup-alternates.spec.ts` | Alternate swap + structural follow-up turn |
| `history-persistence.spec.ts` | Refresh-restore, history drawer, `+ new cut` clears |
| `export-and-render.spec.ts` | EDL download, render-preview submit + spinner |
| `agent-tab.spec.ts` | Agent free-form Q&A renders response |
| `library-tab.spec.ts` | Asset list, click-to-play, filter |
| `graph-tab.spec.ts` | Loader overlay clears, node search works |
| `asset-player.spec.ts` | Modal open from library, close via button + Esc |

## How the reasoner works

`helpers/reasoner.ts` calls Bedrock InvokeModel on
`us.anthropic.claude-sonnet-4-6` (or whatever `E2E_REASONER_MODEL_ID` is
set to). It sends:

- the producer's brief
- the emitted plan JSON
- the KS name + description
- the parsed duration target (if any)
- the agent's classified cut type

and gets back a structured `{pass, score, rationale, issues}` verdict. The
test asserts `pass === true && score >= 6`. Cost is ~$0.005–0.01 per
grading call.

The reasoner uses the same AWS credentials the operator already has loaded
(`AWS_PROFILE=TLSolProd` works), so no new keys.

## Running

```bash
cd ui
# Single pass:
AWS_PROFILE=TLSolProd npm run test:e2e:comprehensive
# Loop until 100% pass (operator stops with Ctrl-C):
AWS_PROFILE=TLSolProd npm run test:e2e:comprehensive:loop
```

The loop runner re-runs ONLY failed tests on each iteration via
`--grep`, and writes a JSON report to `/tmp/loop-runner-<n>.json` per
iteration for inspection. It prints a warning when three iterations in a
row produce the identical failure set — that usually means a
deterministic bug, not flake.

## Cost per full pass

- **Agent runs**: 6 cut-type tests × ~$0.05 each = ~$0.30
- **Bedrock grading**: 6 × ~$0.008 = ~$0.05
- **MediaConvert submit** (export-and-render): ~$0.01 (we don't wait for completion)
- **TwelveLabs Marengo embeddings** baked into agent runs = covered above
- **Total per full pass**: ~$0.40

A loop run that retries 5 failed tests for ~10 iterations could climb
toward $1-2. Watch the iteration counter.

## Env vars

Inherits all the standard E2E env vars from `e2e/.env.test`:

| Var | Purpose |
|---|---|
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` | Cognito sign-in for the headless browser |
| `TEST_KS_ID` | Default test KS (used by existing specs) |
| `AWS_REGION` | Where Bedrock lives (default `us-east-1`) |
| `E2E_REASONER_MODEL_ID` | Override the grader model (default `us.anthropic.claude-sonnet-4-6`) |
| `E2E_BASE_URL` | UI URL to drive (default deployed CloudFront) |

Also needs working AWS credentials in the process env (`AWS_PROFILE` is
the most common path).

## Skipping specific specs

To skip the expensive cut-type matrix temporarily:

```bash
npm run test:e2e:comprehensive -- --grep-invert "cut-types"
```

To run just one spec:

```bash
npm run test:e2e:comprehensive -- cut-types.spec.ts
```
