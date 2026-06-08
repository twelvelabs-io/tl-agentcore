# GDINO Triton Service

Triton-only GPU service for thumbnail patch-candidate extraction.

**Lifted verbatim from `twelvelabs-io/tl-embed` (`services/tl-vcs/expert-models/gdino`)** to deliver Phase 3-proper Re-ID on AWS — open-vocab Grounding DINO detection + DeepSORT tracking + Triton-backed Re-ID embeddings. Use cases: cropping detected entity patches at ingestion so the cross-asset entity index (S3 Vectors) is keyed on tight face/object crops rather than whole frames. See `tl-agentcore/agent/tl_agentcore/agent.py:find_entity_by_image` for the query-time consumer.

Two additions on top of the lift, both at the top level so the lifted `service/` tree is byte-equal to its tl-embed source for future merge-ins:

- `sagemaker_shim.py` — mounts `GET /ping` + `POST /invocations` on the lifted FastAPI app so the container conforms to SageMaker BYOC hosting.
- `Dockerfile` — same as source, with `COPY` paths flattened to match the tl-agentcore build context (`agent/expert-models/gdino/.` is the context).

## What It Does

- `POST /extract_patch_candidates` *(native route, unchanged from source)*
  - decodes video frames with `ffmpeg`
  - runs batched Grounding DINO inference through Triton gRPC
  - runs incremental DeepSORT-style tracking with Triton-backed Re-ID
  - returns flattened per-shot patch candidates and optional reference patches
- `POST /invocations` *(SageMaker BYOC, added by `sagemaker_shim.py`)* — accepts the same body as `/extract_patch_candidates`, returns the same response. Alias.
- `GET /health` *(native route)* — Triton liveness + model readiness, returns a rich JSON body.
- `GET /ping` *(SageMaker BYOC)* — re-uses `/health`, 200 when ready.

This service no longer supports any HuggingFace fallback path. Production and local container runs should both use Triton.

## Directory Layout

- `service/`: runtime FastAPI service and tracking pipeline
- `triton_repo/`: checked-in Triton model repository skeleton with static `config.pbtxt`
- `scripts/benchmark.py`: manual load test utility for a user-supplied GDINO endpoint
- `scripts/monitor.sh`: manual pod resource monitor for a configurable namespace
- `scripts/hyperparam_search.sh`: manual tuning script driven by environment-specific URL and video inputs
- `start.sh`: container startup flow
- `Dockerfile`: container build

## Endpoints

### `POST /extract_patch_candidates`

```json
{
  "video_path": "s3://bucket/video.mp4",
  "text_prompt": "person.",
  "fps": 2.0,
  "box_threshold": 0.15,
  "nms_threshold": 0.5,
  "min_bbox_ratio": 0.1
}
```

Optional fields control tracker weights, time range, shot patch requests, and reference patch requests.

### `GET /health`

```json
{
  "status": "ok",
  "mode": "triton",
  "tracker": "deepsort",
  "gdino_batch_size": 4,
  "tracker_batch_multiplier": 8,
  "tracker_batch_frames": 32,
  "max_concurrent": 2
}
```

## Deployment

### SageMaker (this repo)

Build with the gdino directory as context — paths are flat. **The base image is `nvcr.io/nvidia/tritonserver`, which is linux/amd64 only with NVIDIA GPU; do not build on Apple Silicon.** Use a Linux x86 GPU host (EC2 g5/g6, a CodeBuild project with GPU, or local Linux box with NVIDIA Container Toolkit):

```bash
# From a Linux x86 host with docker + NVIDIA Container Toolkit:
cd agent/expert-models/gdino
docker build -t <ECR_REPO>/gdino:v$(date +%Y%m%d%H%M%S) .
docker push <ECR_REPO>/gdino:<tag>
```

The container hosts two contracts on `:8080`:

- **SageMaker Hosting** (real-time / serverless endpoint) — uses `GET /ping` + `POST /invocations`. Stand up via Terraform (`aws_sagemaker_model` + `aws_sagemaker_endpoint_configuration` + `aws_sagemaker_endpoint`). Note: SageMaker Serverless Inference is **CPU-only** and caps at 6 GB — gdino-Triton will not fit there; use real-time GPU endpoints (g5/g6).
- **SageMaker Processing Jobs** (batch ingest at scale-to-zero) — the same image; pass the body as a CLI arg / file mount instead of HTTP. The Step Functions orchestrator (Step 2 of Phase 3-proper) will submit `create-processing-job` per asset with the typed request as input.

The container startup flow is:

1. download the TAO GDINO ONNX and Re-ID ONNX models
2. build the TensorRT engine (~5–10 min first boot; cached in `TRT_ENGINE_DIR`)
3. populate the Triton model repository from checked-in `config.pbtxt`
4. start Triton
5. start FastAPI via `uvicorn sagemaker_shim:app`

### Original tl-embed k8s path (for reference, not used here)

```bash
scripts/build-push-expert.sh gdino
scripts/deploy-expert-model.sh --model gdino
```

## Key Environment Variables

- `TRITON_GRPC_URL`: Triton gRPC endpoint, default `localhost:8002`
- `TEXT_PROMPT`: default prompt used during warmup, default `person.`
- `GDINO_BATCH_SIZE`: Triton detection batch size, must be between `1` and `8`
- `TRACKER_BATCH_MULTIPLIER`: number of GDINO batches accumulated before tracker flush
- `MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES`: concurrent `/extract_patch_candidates` requests per process
- `MAX_QUEUE_WAIT_SECONDS`: queue wait timeout before `/extract_patch_candidates` rejects
- `TRACKER_APPEARANCE_WEIGHT`
- `TRACKER_MOTION_WEIGHT`
- `TRACKER_MAX_COST`
- `TRACKER_MAX_AGE_SECONDS`
- `TRACKER_MIN_TRACK_SECONDS`
- `TRACKER_MERGE_MAX_GAP_SECONDS`
- `TRACKER_MERGE_COSINE_THRESHOLD`

## Operational Notes

- `/extract_patch_candidates` is intentionally back-pressured with a per-process semaphore.
- Triton CUDA shared memory is best-effort. If registration fails, the service falls back to standard gRPC tensor transfer.
- The service assumes the Triton model name is `gdino_dynamic`.
- Triton `instance_group` counts are fixed in `triton_repo/*/config.pbtxt`.

## Follow-Ups

- Make Re-ID mandatory and remove the current IoU-only tracking fallback path.
