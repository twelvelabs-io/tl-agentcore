#!/usr/bin/env bash
# Idempotent setup for the Playwright E2E test KS.
#
# Creates (or reuses) a TwelveLabs knowledge store named "tl-agentcore-e2e"
# attached to a Marengo + Pegasus index, ingests one short public MP4,
# polls until it's ready, and writes TEST_KS_ID into ui/e2e/.env.test.
#
# Requires:
#   TL_API_KEY    — TwelveLabs API key
#
# Usage:
#   TL_API_KEY=tlk_... ./scripts/setup_test_fixtures.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${TL_API_KEY:-}" ]; then
  echo "TL_API_KEY env var is required" >&2
  exit 1
fi

TL="https://api.twelvelabs.io/v1.3"
H_AUTH=(-H "x-api-key: ${TL_API_KEY}")
H_JSON=(-H "content-type: application/json")
KS_NAME="tl-agentcore-e2e"
INDEX_NAME="tl-agentcore-e2e-index"
# Big Buck Bunny — stable public test MP4, ~10 min, royalty-free.
# Good enough that Marengo finds varied moments to rank.
SAMPLE_URL="${E2E_SAMPLE_URL:-https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4}"
ENV_TEST="ui/e2e/.env.test"

# ─── 1. Index (Marengo 3.0 + Pegasus 1.2) ────────────────────────────────
echo "==> Finding or creating index '$INDEX_NAME'..."
INDEX_ID=$(curl -fsS "${H_AUTH[@]}" "$TL/indexes?page_limit=50" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print(next((i['_id'] for i in d if i.get('index_name')=='$INDEX_NAME'), ''))" )

if [ -z "$INDEX_ID" ]; then
  echo "    creating new index..."
  INDEX_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "$TL/indexes" \
    -d "{\"index_name\":\"$INDEX_NAME\",\"models\":[{\"model_name\":\"marengo2.7\",\"model_options\":[\"visual\",\"audio\"]},{\"model_name\":\"pegasus1.2\",\"model_options\":[\"visual\",\"audio\"]}]}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['_id'])")
fi
echo "    index_id=$INDEX_ID"

# ─── 2. Knowledge store ────────────────────────────────────────────────────
echo "==> Finding or creating knowledge store '$KS_NAME'..."
KS_ID=$(curl -fsS "${H_AUTH[@]}" "$TL/knowledge-stores?page_limit=50" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print(next((k['_id'] for k in d if k.get('name')=='$KS_NAME'), ''))" )

if [ -z "$KS_ID" ]; then
  echo "    creating new KS..."
  KS_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "$TL/knowledge-stores" \
    -d "{\"name\":\"$KS_NAME\",\"description\":\"Playwright E2E fixture\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['_id'])")
fi
echo "    ks_id=$KS_ID"

# ─── 3. Ingest the sample MP4 (only if KS has no ready items) ─────────────
ITEMS=$(curl -fsS "${H_AUTH[@]}" "$TL/knowledge-stores/$KS_ID/items?page_limit=10" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print(sum(1 for i in d if i.get('status')=='ready'))")

if [ "$ITEMS" = "0" ]; then
  echo "==> Ingesting sample video..."
  TASK_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "$TL/knowledge-stores/$KS_ID/items" \
    -d "{\"video_url\":\"$SAMPLE_URL\",\"index_id\":\"$INDEX_ID\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('task_id',''))")
  echo "    task_id=$TASK_ID"

  echo "==> Polling for ready (this can take 5-15 min)..."
  for i in $(seq 1 60); do
    STATUS=$(curl -fsS "${H_AUTH[@]}" "$TL/knowledge-stores/$KS_ID/items?page_limit=10" \
      | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print((d[0] if d else {}).get('status','?'))")
    echo "    [$i] status=$STATUS"
    if [ "$STATUS" = "ready" ]; then break; fi
    if [ "$STATUS" = "failed" ]; then echo "ingestion FAILED" >&2; exit 1; fi
    sleep 30
  done
else
  echo "==> $ITEMS item(s) already ready; skipping ingest."
fi

# ─── 4. Write TEST_KS_ID into ui/e2e/.env.test ─────────────────────────────
mkdir -p ui/e2e
touch "$ENV_TEST"
# Strip any existing TEST_KS_ID line, then append the fresh one.
TMP=$(mktemp)
grep -v "^TEST_KS_ID=" "$ENV_TEST" > "$TMP" || true
echo "TEST_KS_ID=$KS_ID" >> "$TMP"
mv "$TMP" "$ENV_TEST"
echo "==> wrote TEST_KS_ID=$KS_ID to $ENV_TEST"

echo
echo "Done. Run E2E with:  cd ui && npm run test:e2e"
