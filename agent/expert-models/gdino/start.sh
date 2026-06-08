#!/usr/bin/env bash
# Startup: download models → build TRT engine → start Triton + FastAPI.
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

# ── Step 1: (skipped — GDINO is loaded in-process via HuggingFace now) ────
# The TAO NGC export was dropped after we discovered it depends on the
# TensorRT-only `MultiscaleDeformableAttnPlugin_TRT` op, which doesn't
# load under any Triton version compatible with the SageMaker ml.g5
# host's NVIDIA driver. The HF `IDEA-Research/grounding-dino-tiny`
# weights are baked into the container image at build time and loaded
# in-process by service/triton_backend.py at preload_runtime(). Only the
# Re-ID model still lives in the Triton repo (its ONNX is plugin-free).

# ── Step 2: Download Re-ID ONNX ─────────────────────────────────────────────
if [ ! -f "$REID_ONNX" ]; then
    echo "[2/4] Downloading Re-ID ONNX..."
    mkdir -p "$REID_DIR"
    wget -q -O "$REID_ONNX" "$REID_URL"
    [ ! -s "$REID_ONNX" ] && echo "ERROR: download failed" && exit 1
    echo "  $(du -h "$REID_ONNX" | cut -f1)"
fi

# ── Step 3: (skipped — TRT/ONNX gdino path is replaced by HF in-process) ───

# ── Step 4: Triton model repo + start server (Re-ID only) ───────────────────
# Only Re-ID is served by Triton now. GDINO runs in-process inside the
# FastAPI server (see service/triton_backend.py).
echo "[4/4] Setting up Triton..."
mkdir -p "$TRITON_REPO/reid/1"
cp "$STATIC_TRITON_REPO/reid/config.pbtxt" "$TRITON_REPO/reid/config.pbtxt"
cp "$REID_ONNX" "$TRITON_REPO/reid/1/model.onnx"

tritonserver \
    --model-repository="$TRITON_REPO" \
    --log-verbose=0 \
    --http-port=8001 \
    --grpc-port=8002 \
    --metrics-port=8003 \
    &

for i in $(seq 1 120); do
    curl -s http://localhost:8001/v2/health/ready > /dev/null 2>&1 && break
    sleep 2
done
curl -s http://localhost:8001/v2/health/ready > /dev/null 2>&1 || { echo "ERROR: Triton failed"; exit 1; }

echo "=== Ready: Triton :8002, FastAPI :8080 ==="
# SageMaker BYOC entrypoint — sagemaker_shim adds /ping + /invocations on top
# of the lifted service.server.app (which still serves /health and
# /extract_patch_candidates for direct/dev access).
exec uvicorn sagemaker_shim:app --host 0.0.0.0 --port 8080 --workers 1 \
    --timeout-keep-alive 620
