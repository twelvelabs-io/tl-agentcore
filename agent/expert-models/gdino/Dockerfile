# Grounding DINO Expert Model — Triton Inference Server
#
# Base: nvcr.io/nvidia/tritonserver (includes TRT, CUDA, trtexec, tritonserver)
# Build on a Linux x86 machine — NOT Mac (QEMU cross-build is unreliable).
#
# Triton 22.12 (CUDA 11.8, driver >= 450) is pinned for SageMaker ml.g5
# host compatibility — the AWS-managed AMI ships NVIDIA driver 470.x,
# which is too old for Triton 23.04+ (driver 525+) and 24.10 (driver 560+).
# Don't upgrade without first verifying the SageMaker host driver version
# via the endpoint's CloudWatch logs.
#
# On first boot, start.sh:
#   1. Downloads TAO GDINO ONNX + Re-ID ONNX from NGC.
#   2. Builds multi-input TRT engine via trtexec.
#   3. Sets up Triton model repo (GDINO TRT + Re-ID ONNX).
#   4. Starts Triton server (gRPC :8002) + FastAPI wrapper (:8080).

FROM nvcr.io/nvidia/tritonserver:22.12-py3

# ── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        wget ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# ── Python deps ──────────────────────────────────────────────────────────────
# Triton 22.12-py3 ships Python 3.8. The lifted service/* uses PEP 585
# generics (list[X], dict[X,Y]) which are runtime types in Python 3.9+.
# `from __future__ import annotations` is set in every service file, which
# makes annotations lazy strings — Pydantic v2's type resolver handles
# them on Python 3.8. tritonclient is pinned to a version that matches
# Triton 22.12 server (forward-compat is reliable; the 2.x line shipped
# alongside this server release).
WORKDIR /app

RUN pip install --no-cache-dir --timeout 600 \
    "fastapi>=0.103.0,<0.116.0" \
    "uvicorn[standard]>=0.23.0,<0.31.0" \
    "transformers>=4.42.0,<4.50.0" \
    "pydantic>=2.0.0,<3.0.0" \
    "Pillow>=10.0.0" \
    "numpy>=1.24.0,<2.0.0" \
    "scipy>=1.10.0,<1.14.0" \
    "protobuf>=3.20.0,<5.0.0" \
    "tritonclient[all]>=2.29.0,<2.41.0" \
    "opencv-python-headless>=4.8.0" \
    "onnx>=1.13.0,<1.15.0" \
    "eval_type_backport>=0.2.0"
# eval_type_backport: lets Pydantic v2 evaluate PEP 585 generics
# (list[X], dict[X,Y]) on Python 3.8 (which Triton 22.12-py3 ships).
# Without it, every model file using `from __future__ import annotations`
# crashes at class-construction time with "Unable to evaluate type
# annotation 'list[float]'".

# PyTorch with CUDA 11.8 wheels. The Triton 22.12 base image already ships
# PyTorch for its libtorch backend, but at a version older than what
# transformers 4.42+ wants. Install a clean cu118 torch from PyTorch's index
# in a separate RUN so the index URL doesn't pollute the regular pip install.
# Pin to a torch version known to work with our transformers range.
RUN pip install --no-cache-dir --timeout 600 \
    --index-url https://download.pytorch.org/whl/cu118 \
    "torch==2.1.2"

# Pre-download the HF GroundingDINO weights at image build time so the
# first endpoint cold-start doesn't pay the network cost. ~700 MB; cached
# under /root/.cache/huggingface.
ARG HF_GDINO_MODEL_ID=IDEA-Research/grounding-dino-tiny
RUN python3 -c "from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection; \
    AutoProcessor.from_pretrained('${HF_GDINO_MODEL_ID}'); \
    AutoModelForZeroShotObjectDetection.from_pretrained('${HF_GDINO_MODEL_ID}')"
ENV HF_GDINO_MODEL_ID=${HF_GDINO_MODEL_ID}

# ── Application code ─────────────────────────────────────────────────────────
# Build context is this directory (agent/expert-models/gdino/), so paths are
# flat — no expert-models/gdino/ prefix as in the source tl-embed Dockerfile.
# sagemaker_shim.py mounts /ping + /invocations on top of the lifted FastAPI
# app so the container conforms to the SageMaker BYOC hosting contract.
COPY service ./service
COPY scripts ./scripts
COPY triton_repo ./triton_repo
COPY start.sh .
COPY processing.sh .
COPY sagemaker_shim.py .
COPY processing_entrypoint.py .
RUN chmod +x start.sh processing.sh

# ── Environment ──────────────────────────────────────────────────────────────
ENV DEVICE=cuda
ENV TRT_ENGINE_DIR=/models/gdino_trt
ENV MODEL_DIR=/models/gdino_tao
ENV TRITON_REPO=/models/triton_repo
ENV REID_DIR=/models/reid
ENV TEXT_PROMPT="person."
ENV TRACKER_TYPE=deepsort
ENV TRITON_GRPC_URL=localhost:8002
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

# ENTRYPOINT (not CMD) — SageMaker BYOC hosting calls `docker run <image> serve`,
# which REPLACES CMD with the literal arg "serve". Using ENTRYPOINT keeps our
# startup script as the actual entrypoint and the "serve" arg gets passed in
# as $1 (which start.sh ignores). Without this, SageMaker hosts run Triton's
# default entrypoint instead and the container fails with "No model found
# in model repository". Took one full failed deploy to diagnose.
ENTRYPOINT ["./start.sh"]
