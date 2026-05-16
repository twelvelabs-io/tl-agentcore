#!/usr/bin/env bash
# Idempotent setup for the Playwright E2E test KS.
#
# Creates (or reuses) a TwelveLabs index + knowledge store, registers a
# short public MP4 as an asset, attaches it to the KS, polls until ready,
# and writes TEST_KS_ID into ui/e2e/.env.test.
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
# 10-second, 1 MB Big Buck Bunny clip. Stable public mirror, royalty-free,
# small enough that TL ingest finishes in seconds.
SAMPLE_URL="${E2E_SAMPLE_URL:-https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4}"
ENV_TEST="ui/e2e/.env.test"

# ─── 1. Index (Marengo 3.0 + Pegasus 1.2) ────────────────────────────────
echo "==> Finding or creating index '$INDEX_NAME'..."
INDEX_ID=$(curl -fsS "${H_AUTH[@]}" "$TL/indexes?page_limit=50" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print(next((i['_id'] for i in d if i.get('index_name')=='$INDEX_NAME'), ''))" )

if [ -z "$INDEX_ID" ]; then
  echo "    creating new index..."
  INDEX_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "$TL/indexes" \
    -d "{\"index_name\":\"$INDEX_NAME\",\"models\":[{\"model_name\":\"marengo3.0\",\"model_options\":[\"visual\",\"audio\"]},{\"model_name\":\"pegasus1.2\",\"model_options\":[\"visual\",\"audio\"]}]}" \
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

# ─── 3. Asset + Marengo index task + KS item ─────────────────────────────
#
# Three TL surfaces have to be populated for the agent to see the video:
#   (a) POST /assets         registers the file in your TL account
#   (b) POST /tasks          indexes the video inside the Marengo index
#   (c) POST /knowledge-stores/{ks}/items   links the asset to the KS
# Step (b) is what makes list_tl_indexes() see a non-zero video_count;
# without it, the agent rightly bails out with "knowledge store is empty".

INDEX_VIDEOS=$(curl -fsS "${H_AUTH[@]}" "$TL/indexes/$INDEX_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('video_count',0))")

if [ "$INDEX_VIDEOS" = "0" ]; then
  echo "==> Creating asset from $SAMPLE_URL..."
  ASSET_ID=$(curl -fsS "${H_AUTH[@]}" -X POST "$TL/assets" \
    -F "url=$SAMPLE_URL" -F "index_id=$INDEX_ID" -F "method=url" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['_id'])")
  echo "    asset_id=$ASSET_ID"

  echo "==> Submitting Marengo indexing task..."
  TASK_ID=$(curl -fsS "${H_AUTH[@]}" -X POST "$TL/tasks" \
    -F "index_id=$INDEX_ID" -F "video_url=$SAMPLE_URL" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['_id'])")
  echo "    task_id=$TASK_ID"

  echo "==> Polling for task ready (10 s clip — usually a few minutes)..."
  for i in $(seq 1 40); do
    STATUS=$(curl -fsS "${H_AUTH[@]}" "$TL/tasks/$TASK_ID" \
      | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))")
    echo "    [$i] task=$STATUS"
    if [ "$STATUS" = "ready" ]; then break; fi
    if [ "$STATUS" = "failed" ]; then echo "indexing FAILED" >&2; exit 1; fi
    sleep 15
  done

  echo "==> Attaching asset to KS..."
  curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "$TL/knowledge-stores/$KS_ID/items" \
    -d "{\"asset_id\":\"$ASSET_ID\"}" >/dev/null
  echo "    attached."
else
  echo "==> Index already has $INDEX_VIDEOS video(s); skipping ingest."
fi

# ─── 4. Ingest Marengo clip embeddings into the S3 Vector index ───────────
#
# Skipped automatically if VECTOR_BUCKET_NAME is unset (lets the script
# stay useful in scenarios where infra isn't deployed yet). When set, the
# ingest script is idempotent: re-running for an already-embedded asset
# just upserts the same vectors.
if [ -n "${VECTOR_BUCKET_NAME:-}" ]; then
  echo "==> Ingesting clip embeddings into s3vectors://${VECTOR_BUCKET_NAME}"
  TL_API_KEY="${TL_API_KEY}" \
    VECTOR_BUCKET_NAME="${VECTOR_BUCKET_NAME}" \
    VECTOR_INDEX_NAME="${VECTOR_INDEX_NAME:-clips}" \
    AWS_REGION="${AWS_REGION:-us-east-1}" \
    python3 scripts/ingest_vectors.py "$KS_ID"
else
  echo "==> VECTOR_BUCKET_NAME not set; skipping vector ingest"
  echo "    (run scripts/ingest_vectors.py separately when ready)"
fi

# ─── 5. Write TEST_KS_ID into ui/e2e/.env.test ─────────────────────────────
mkdir -p ui/e2e
touch "$ENV_TEST"
TMP=$(mktemp)
grep -v "^TEST_KS_ID=" "$ENV_TEST" > "$TMP" || true
echo "TEST_KS_ID=$KS_ID" >> "$TMP"
mv "$TMP" "$ENV_TEST"
echo "==> wrote TEST_KS_ID=$KS_ID to $ENV_TEST"

echo
echo "Done. Run E2E with:  cd ui && npm run test:e2e"
