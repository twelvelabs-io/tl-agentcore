#!/usr/bin/env bash
# SageMaker Processing Job wrapper.
#
# Same first-boot setup as start.sh (download ONNX → build TRT engine →
# populate Triton model repo → start Triton), but instead of execing
# uvicorn at the end, runs processing_entrypoint.py once and exits when
# the entrypoint exits. Triton dies with the container.
#
# Processing Jobs run-and-die; warm-state caching matters less than for
# the hosted endpoint, but the TRT engine compilation is still cached to
# /models so a job container that's been used before by the same instance
# (rare but possible) reuses it.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STATIC_TRITON_REPO="${SCRIPT_DIR}/triton_repo"
MODEL_DIR="${MODEL_DIR:-/models/gdino_tao}"
TRT_ENGINE_DIR="${TRT_ENGINE_DIR:-/models/gdino_trt}"
TRITON_REPO="${TRITON_REPO:-/models/triton_repo}"
REID_DIR="${REID_DIR:-/models/reid}"
ONNX_FILE="${MODEL_DIR}/model.onnx"
ENGINE_FILE="${TRT_ENGINE_DIR}/model.engine"
REID_ONNX="${REID_DIR}/resnet50_market1501_aicity156.onnx"

GDINO_URL="https://api.ngc.nvidia.com/v2/models/nvidia/tao/grounding_dino/versions/grounding_dino_swin_tiny_commercial_deployable_v1.0/files/grounding_dino_swin_tiny_commercial_deployable.onnx"
REID_URL="https://api.ngc.nvidia.com/v2/models/nvidia/tao/reidentificationnet/versions/deployable_v1.2/files/resnet50_market1501_aicity156.onnx"

SHAPES_MIN="inputs:1x3x544x960,input_ids:1x256,attention_mask:1x256,position_ids:1x256,token_type_ids:1x256,text_token_mask:1x256x256"
SHAPES_OPT="inputs:1x3x544x960,input_ids:1x256,attention_mask:1x256,position_ids:1x256,token_type_ids:1x256,text_token_mask:1x256x256"
SHAPES_MAX="inputs:8x3x544x960,input_ids:8x256,attention_mask:8x256,position_ids:8x256,token_type_ids:8x256,text_token_mask:8x256x256"

if [ ! -f "$ONNX_FILE" ]; then
    echo "[1/4] Downloading GDINO ONNX..."
    mkdir -p "$MODEL_DIR"
    wget -q -O "$ONNX_FILE" "$GDINO_URL"
    [ ! -s "$ONNX_FILE" ] && echo "ERROR: download failed" && exit 1

    # Same IR-version downgrade as start.sh — TAO export is IR v9, Triton
    # 22.12 ORT 1.13 supports up to IR v8.
    python3 - <<PY
import onnx
m = onnx.load("$ONNX_FILE")
if m.ir_version > 8:
    m.ir_version = 8
    onnx.save(m, "$ONNX_FILE")
PY
fi

if [ ! -f "$REID_ONNX" ]; then
    echo "[2/4] Downloading Re-ID ONNX..."
    mkdir -p "$REID_DIR"
    wget -q -O "$REID_ONNX" "$REID_URL"
    [ ! -s "$REID_ONNX" ] && echo "ERROR: download failed" && exit 1
fi

# Skipped: TRT engine build. Triton 22.12's TRT 8.5 can't import the
# LayerNormalization op from the TAO GDINO ONNX; we serve via onnxruntime
# backend instead. See start.sh + triton_repo config for the same change.

echo "[4/4] Setting up Triton..."
mkdir -p "$TRITON_REPO/gdino_dynamic/1" "$TRITON_REPO/reid/1"
cp "$STATIC_TRITON_REPO/gdino_dynamic/config.pbtxt" "$TRITON_REPO/gdino_dynamic/config.pbtxt"
cp "$STATIC_TRITON_REPO/reid/config.pbtxt" "$TRITON_REPO/reid/config.pbtxt"
cp "$ONNX_FILE" "$TRITON_REPO/gdino_dynamic/1/model.onnx"
cp "$REID_ONNX" "$TRITON_REPO/reid/1/model.onnx"

tritonserver \
    --model-repository="$TRITON_REPO" \
    --log-verbose=0 \
    --http-port=8001 \
    --grpc-port=8002 \
    --metrics-port=8003 \
    &
TRITON_PID=$!

# Wait for Triton readiness — same loop as start.sh.
for i in $(seq 1 120); do
    curl -s http://localhost:8001/v2/health/ready > /dev/null 2>&1 && break
    sleep 2
done
curl -s http://localhost:8001/v2/health/ready > /dev/null 2>&1 || { echo "ERROR: Triton failed"; exit 1; }

echo "=== Triton ready :8002 — running processing entrypoint ==="
# Run-and-die. SageMaker uploads /opt/ml/processing/output/* to S3 on exit.
python /app/processing_entrypoint.py
RC=$?

# Triton will be killed by the container exit; nudge it explicitly for clean logs.
kill "$TRITON_PID" 2>/dev/null || true
exit "$RC"
