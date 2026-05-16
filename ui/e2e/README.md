# E2E (Playwright)

End-to-end tests that drive the **deployed** CloudFront URL with a real
Cognito test user and a real test KS. Each run hits TwelveLabs + Bedrock,
so it costs cents and takes minutes. Don't put these in a tight pre-commit
loop.

## What's covered

| Spec | Asserts |
|---|---|
| `01-signin.spec.ts` | Unauthenticated boot redirects to Hosted UI; signed-in masthead shows the user's email; status pip flips to `live`. |
| `02-ks-picker.spec.ts` | Picker populates from `/tl/knowledge-stores`; the test KS id is reachable. |
| `03-roughcut-plan.spec.ts` | Submit a brief → plan renders → timeline header shows N scenes / N clips; EDL button appears. |
| `04-roughcut-alternates.spec.ts` | Every clip exposes a Marengo-ranked alternates strip; clicking *use this →* swaps the primary. |
| `05-history.spec.ts` | Saved entries appear in the history strip and the active one is highlighted. |
| `06-edl-export.spec.ts` | Export button triggers a `.edl` download containing `TITLE:` + `FCM:`. |
| `07-agent-tab.spec.ts` | Agent tab renders the correct tool catalog (no Jockey anywhere); a chat turn streams a non-trivial response. |
| `08-signout.spec.ts` | Sign-out clears session and bounces back to Cognito Hosted UI. |

## One-time setup

The dedicated test fixtures (Cognito user, TL KS with an indexed video)
have to exist before tests can run. The user lives in the AgentCore
Cognito pool; the KS lives in your TwelveLabs account.

### 1. Test user

```bash
TEST_PASS="E2EPlay!$(openssl rand -base64 12 | tr -d '/+=' | head -c 12)"

AWS_PROFILE=TLSolProd AWS_REGION=us-east-1 \
  aws cognito-idp admin-create-user \
    --user-pool-id us-east-1_LQDmyKlEp \
    --username e2e-playwright@twelvelabs.io \
    --user-attributes Name=email,Value=e2e-playwright@twelvelabs.io Name=email_verified,Value=true \
    --message-action SUPPRESS

AWS_PROFILE=TLSolProd AWS_REGION=us-east-1 \
  aws cognito-idp admin-set-user-password \
    --user-pool-id us-east-1_LQDmyKlEp \
    --username e2e-playwright@twelvelabs.io \
    --password "$TEST_PASS" --permanent

echo "TEST_USER_EMAIL=e2e-playwright@twelvelabs.io"  > e2e/.env.test
echo "TEST_USER_PASSWORD=$TEST_PASS"                >> e2e/.env.test
```

The `--message-action SUPPRESS` skips Cognito's welcome email; the
`--permanent` flag clears the FORCE_CHANGE_PASSWORD state so the user
can sign in straight away.

### 2. Test KS

Use `../scripts/setup_test_fixtures.sh` to create a KS, ingest one short
public MP4, and write `TEST_KS_ID` into `e2e/.env.test`. Ingestion is
slow (5-15 min for a short clip) so do this once and forget it.

```bash
cd ..
TL_API_KEY=$(grep TL_API_KEY .env | cut -d= -f2-) \
  ./scripts/setup_test_fixtures.sh
```

The script idempotently reuses an existing KS named `tl-agentcore-e2e`
if you re-run it.

## Run

```bash
cd ui

# Headless run, all specs:
npm run test:e2e

# Interactive UI mode (best for iterating on a single spec):
npm run test:e2e:ui

# Debug a single spec with the inspector:
npm run test:e2e:debug -- e2e/04-roughcut-alternates.spec.ts

# Open the last HTML report:
npm run test:e2e:report
```

## What the suite costs

Per full run (8 specs, 1 worker):

- ~6 RoughCut generations × ~$0.03 in Bedrock + TL = **~$0.18**
- ~1 Agent chat turn × ~$0.01 = **~$0.01**
- API Gateway WebSocket + Lambda = pennies
- **Total: roughly $0.20 per full pass**

A 6-beat reel takes 30-90 s of agent wall-clock; the suite as a whole
runs in 8-12 minutes on a single worker.

## Gotchas

- **`fullyParallel: false`** in `playwright.config.ts`. Agent calls hit
  shared session id semantics in AgentCore Runtime; parallel sessions
  also bloat TL spend. Don't crank workers.
- **Storage state cache.** After the first run, `e2e/storage-state.json`
  holds valid Cognito tokens. Subsequent runs skip the Hosted UI dance
  until they expire (24h). Delete the file to force a fresh sign-in.
- **TL indexing latency.** If you delete the test KS, `setup_test_fixtures.sh`
  will re-ingest. Plan ~15 min before the suite is green again.
- **CloudFront propagation.** If you redeployed the UI within the last
  ~5 min, run a hard refresh in a normal browser before trusting test
  failures — you might be hitting a stale edge cache.
