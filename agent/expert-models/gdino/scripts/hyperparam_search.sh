#!/usr/bin/env bash
# Hyperparameter search for GDINO server optimal config under bulk load.
# Tests combinations of batch sizes, concurrency, and tracker multipliers.
# Each config: set env vars → restart pod → wait ready → benchmark at target concurrency.
# Environment:
#   NAMESPACE             K8s namespace (default: tl-vcs)
#   DEPLOY                Deployment name (default: expert-gdino)
#   URL                   Base URL of the deployed GDINO service (required)
#   VIDEO_URL             Presigned or public test video URL
#   VIDEO_S3_URI          S3 URI to presign when VIDEO_URL is unset
#   VIDEO_URL_EXPIRES_IN  Presign TTL in seconds (default: 14400)
#   BENCHMARK             Benchmark command (default: script-local benchmark.py)
#   RESULTS_FILE          Output file (default: /tmp/hyperparam_results.txt)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${NAMESPACE:-tl-vcs}"
DEPLOY="${DEPLOY:-expert-gdino}"
URL="${URL:-}"
BENCHMARK="${BENCHMARK:-python3 ${SCRIPT_DIR}/benchmark.py}"
RESULTS_FILE="${RESULTS_FILE:-/tmp/hyperparam_results.txt}"

if [[ -z "$URL" ]]; then
    echo "Set URL to the GDINO service base URL before running this script." >&2
    exit 1
fi

if [[ -z "${VIDEO_URL:-}" ]]; then
    if [[ -n "${VIDEO_S3_URI:-}" ]]; then
        VIDEO_URL=$(aws s3 presign "$VIDEO_S3_URI" --expires-in "${VIDEO_URL_EXPIRES_IN:-14400}")
    else
        echo "Set VIDEO_URL or VIDEO_S3_URI to a benchmark video before running this script." >&2
        exit 1
    fi
fi

echo "=== Hyperparameter Search $(date) ===" > "$RESULTS_FILE"
echo "" >> "$RESULTS_FILE"

run_config() {
    local concurrent="$1"
    local batch="$2"
    local mult="$3"
    local test_concurrency="$4"
    local label="C=${concurrent} B=${batch} M=${mult}"

    echo ""
    echo "================================================================"
    echo "  Testing: $label (test at C=${test_concurrency})"
    echo "================================================================"

    # Set env vars on deployment. Triton instance counts are fixed in checked-in config.pbtxt.
    kubectl set env deployment/"$DEPLOY" -n "$NAMESPACE" \
        MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES="$concurrent" \
        GDINO_BATCH_SIZE="$batch" \
        TRACKER_BATCH_MULTIPLIER="$mult" \
        > /dev/null

    # Wait for rollout
    kubectl rollout status deployment/"$DEPLOY" -n "$NAMESPACE" --timeout=600s 2>/dev/null

    # Wait for health
    for i in $(seq 1 60); do
        if curl -sf "${URL}/health" > /dev/null 2>&1; then break; fi
        sleep 3
    done

    # Verify config
    health=$(curl -sf "${URL}/health" 2>/dev/null || echo "{}")
    echo "  Health: $health"

    # Run benchmark
    result=$($BENCHMARK --url "$URL" --video "$VIDEO_URL" --fps 5 --concurrency "$test_concurrency" 2>&1)
    echo "$result"

    # Extract key metrics
    avg_fps=$(echo "$result" | grep "Avg FPS" | tail -1 | awk '{print $(NF-1)}')
    avg_server=$(echo "$result" | grep "Avg Server" | tail -1 | awk '{print $(NF-2)}' | tr -d 's')
    total_wall=$(echo "$result" | grep "Total Wall" | tail -1 | awk '{print $(NF-2)}' | tr -d 's')

    # Log result
    printf "%-45s  wall=%6s  server=%6s  fps=%5s\n" "$label @C${test_concurrency}" "$total_wall" "$avg_server" "$avg_fps" | tee -a "$RESULTS_FILE"
}

echo "Video URL ready. Starting search..."
echo ""

# ============================================================================
# Search space: focused on bulk throughput (test at C=concurrent)
# ============================================================================

# --- Baseline: current config ---
run_config 3 4 8  3

# --- Vary concurrency ---
run_config 2 4 8  2
run_config 4 4 8  4

# --- Vary batch size ---
run_config 3 8 8  3
run_config 3 2 8  3

# --- Vary tracker multiplier ---
run_config 3 4 4  3
run_config 3 4 16 3

# --- Combined candidates ---
run_config 4 4 16 4
run_config 4 8 8  4

echo ""
echo "================================================================"
echo "  RESULTS SUMMARY"
echo "================================================================"
sort -t= -k4 -rn "$RESULTS_FILE" | grep -v "^==\|^$"
echo ""
echo "Full results in: $RESULTS_FILE"
