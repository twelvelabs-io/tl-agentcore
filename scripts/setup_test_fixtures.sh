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
  # Resolve the existing asset_id so the mirror step still runs on re-runs.
  ASSET_ID=$(curl -fsS "${H_AUTH[@]}" "$TL/knowledge-stores/$KS_ID/items?page_limit=50" \
    | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print((d[0] if d else {}).get('asset_id',''))")
fi

# ─── 4. Mirror asset bytes into the clips bucket ──────────────────────────
#
# Bedrock-native Marengo + Pegasus read media from S3 only (no URL input).
# We stage every KS asset at clips/<asset_id>.mp4 so ingest_vectors and the
# runtime Pegasus call can find each one deterministically. The fixture
# holds three short clips with distinct content (Bunny, Jellyfish, Sintel)
# so the alternates spec sees real variety, not duplicates.
filename_to_url() {
  # Case statement instead of `declare -A` so this works on macOS bash 3.2.
  case "$1" in
    Big_Buck_Bunny_360_10s_1MB.mp4) echo "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4" ;;
    Jellyfish_360_10s_1MB.mp4)      echo "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4" ;;
    Sintel_360_10s_1MB.mp4)         echo "https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4" ;;
    *) echo "" ;;
  esac
}

if [ -n "${CLIPS_BUCKET_NAME:-}" ]; then
  echo "==> Mirroring each KS asset into s3://${CLIPS_BUCKET_NAME}/clips/"
  ASSET_IDS=$(curl -fsS "${H_AUTH[@]}" "$TL/knowledge-stores/$KS_ID/items?page_limit=50" \
    | python3 -c "import json,sys
for it in json.load(sys.stdin).get('data',[]):
    print(it.get('asset_id'))")
  for AID in $ASSET_IDS; do
    [ -z "$AID" ] && continue
    FN=$(curl -fsS "${H_AUTH[@]}" "$TL/assets/$AID" \
          | python3 -c "import json,sys; print(json.load(sys.stdin).get('filename',''))")
    URL=$(filename_to_url "$FN")
    if [ -z "$URL" ]; then
      echo "    [$AID] WARN no source URL mapped for filename '$FN'; skipping"
      continue
    fi
    S3_KEY="clips/${AID}.mp4"
    echo "    [$AID] $FN -> s3://${CLIPS_BUCKET_NAME}/${S3_KEY}"
    TMP=$(mktemp -t clip-XXXXX.mp4)
    curl -fsSL -o "$TMP" "$URL"
    aws s3 cp "$TMP" "s3://${CLIPS_BUCKET_NAME}/${S3_KEY}" --content-type video/mp4 >/dev/null
    rm -f "$TMP"
  done
else
  echo "==> CLIPS_BUCKET_NAME not set; skipping S3 mirror"
  echo "    (export it and re-run to enable Bedrock-native ingest/analysis)"
fi

# ─── 5. Ingest Marengo clip embeddings into the S3 Vector index ───────────
#
# Pure-AWS ingest: calls Bedrock Marengo 3.0 via StartAsyncInvoke against
# the mirrored S3 object. The TL API is touched only to list KS items.
if [ -n "${VECTOR_BUCKET_NAME:-}" ] && [ -n "${CLIPS_BUCKET_NAME:-}" ]; then
  echo "==> Ingesting clip embeddings into s3vectors://${VECTOR_BUCKET_NAME}"
  TL_API_KEY="${TL_API_KEY}" \
    CLIPS_BUCKET_NAME="${CLIPS_BUCKET_NAME}" \
    VECTOR_BUCKET_NAME="${VECTOR_BUCKET_NAME}" \
    VECTOR_INDEX_NAME="${VECTOR_INDEX_NAME:-clips}" \
    AWS_REGION="${AWS_REGION:-us-east-1}" \
    python3 scripts/ingest_vectors.py "$KS_ID"
else
  echo "==> VECTOR_BUCKET_NAME / CLIPS_BUCKET_NAME not set; skipping vector ingest"
  echo "    (export both and run scripts/ingest_vectors.py separately when ready)"
fi

# ─── 6. Empty KS fixture (no assets, no vectors) ──────────────────────────
# Used by the empty-index E2E spec to assert that the UI handles the
# agent's prose-only "the index is empty" response gracefully (no
# "Error: ..." prefix, no thrown JSON-parse complaint).
EMPTY_KS_NAME="tl-agentcore-e2e-empty"
echo "==> Finding or creating empty KS '$EMPTY_KS_NAME'..."
EMPTY_KS_ID=$(curl -fsS "${H_AUTH[@]}" "$TL/knowledge-stores?page_limit=50" \
  | python3 -c "import json,sys; d=json.load(sys.stdin).get('data',[]); print(next((k['_id'] for k in d if k.get('name')=='$EMPTY_KS_NAME'), ''))" )

if [ -z "$EMPTY_KS_ID" ]; then
  echo "    creating new empty KS..."
  EMPTY_KS_ID=$(curl -fsS "${H_AUTH[@]}" "${H_JSON[@]}" -X POST "$TL/knowledge-stores" \
    -d "{\"name\":\"$EMPTY_KS_NAME\",\"description\":\"Playwright E2E empty-index fixture (no assets, no vectors)\"}" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['_id'])")
fi
echo "    empty_ks_id=$EMPTY_KS_ID"
# Deliberately do NOT attach assets or run ingest_vectors against this KS.

# ─── 7. Write TEST_KS_ID + TEST_EMPTY_KS_ID into ui/e2e/.env.test ─────────
mkdir -p ui/e2e
touch "$ENV_TEST"
TMP=$(mktemp)
grep -vE "^(TEST_KS_ID|TEST_EMPTY_KS_ID)=" "$ENV_TEST" > "$TMP" || true
echo "TEST_KS_ID=$KS_ID" >> "$TMP"
echo "TEST_EMPTY_KS_ID=$EMPTY_KS_ID" >> "$TMP"
mv "$TMP" "$ENV_TEST"
echo "==> wrote TEST_KS_ID=$KS_ID and TEST_EMPTY_KS_ID=$EMPTY_KS_ID to $ENV_TEST"

echo
echo "Done. Run E2E with:  cd ui && npm run test:e2e"
