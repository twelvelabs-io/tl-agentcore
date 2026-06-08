"""GDINO inference backend.

**This module's NAME is historical** — when lifted from tl-embed it called
NVIDIA Triton over gRPC for GDINO inference. After Phase 3-proper path
discovery, the TAO ONNX export turned out to depend on a TensorRT-only
plugin (`MultiscaleDeformableAttnPlugin_TRT`) which isn't available in any
Triton version compatible with the SageMaker ml.g5 host's NVIDIA driver
(470). We pivoted to running HuggingFace's `IDEA-Research/grounding-dino-tiny`
in-process via PyTorch.

The PUBLIC API of this module is preserved so `tracking_pipeline.py`,
`tracker.py`, and `server.py` continue to import unchanged:

  preprocess_gdino_image(image)       — per-frame CPU preprocessing
  submit_async_infer_batch(...)       — submit a batch, return Future
  collect_batch_detections(future...) — gather Detection objects
  preload_runtime()                   — warm the model
  check_health()                      — readiness probe
  acquire_cuda_shm / release_cuda_shm — no-ops (Triton-era perf opt)
  init_cuda_shm_pool                  — no-op
  get_triton_client                   — kept for reid (tracker.py uses Triton)
  get_triton_tokenizer / tokenize_for_triton — kept as compat shims

The Re-ID model remains on Triton — `tracker.py` has its own Triton client
and the reid ONNX is plugin-free. See `triton_repo/reid/config.pbtxt`.
"""

from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any

import numpy as np

from .config import (
    DEFAULT_PROMPT,
    GDINO_BATCH_SIZE,
    GDINO_INPUT_HEIGHT,
    GDINO_INPUT_WIDTH,
    MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES,
    TRITON_GRPC_URL,
    TRITON_MODEL_NAME,
)
from .schemas import Detection

logger = logging.getLogger(__name__)

# ─── HF GroundingDINO ──────────────────────────────────────────────────────
HF_MODEL_ID = os.environ.get("HF_GDINO_MODEL_ID", "IDEA-Research/grounding-dino-tiny")
HF_DEVICE = os.environ.get("HF_GDINO_DEVICE", "cuda")
# Confidence threshold passed to post_process_grounded_object_detection.
# We re-threshold downstream too; this just cuts the raw queries early.
HF_BOX_THRESHOLD = float(os.environ.get("HF_BOX_THRESHOLD", "0.20"))
HF_TEXT_THRESHOLD = float(os.environ.get("HF_TEXT_THRESHOLD", "0.20"))

_hf_model: Any = None
_hf_processor: Any = None
_hf_device: Any = None
_hf_lock = threading.Lock()
# Single-worker pool: GPU inference is serialized inside PyTorch anyway,
# and a deeper queue just adds tail latency without throughput.
_executor: ThreadPoolExecutor | None = None


def _ensure_hf_loaded() -> None:
    """First-use lazy load. Both submit_async_infer_batch and preload_runtime
    funnel through here so the FastAPI startup event warms the cache and
    later requests get a hot model."""
    global _hf_model, _hf_processor, _hf_device, _executor  # noqa: PLW0603
    if _hf_model is not None:
        return
    with _hf_lock:
        if _hf_model is not None:
            return
        import torch  # noqa: PLC0415
        from transformers import (  # noqa: PLC0415
            AutoModelForZeroShotObjectDetection,
            AutoProcessor,
        )

        _hf_device = torch.device(HF_DEVICE if torch.cuda.is_available() else "cpu")
        logger.info("Loading HF GroundingDINO %s on %s", HF_MODEL_ID, _hf_device)
        _hf_processor = AutoProcessor.from_pretrained(HF_MODEL_ID)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(HF_MODEL_ID)
        model = model.to(_hf_device).eval()
        _hf_model = model
        _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hf-gdino")
        logger.info("HF GroundingDINO ready on %s", _hf_device)


# ─── Public API: preprocessing + CUDA shm (Triton-era no-ops) ──────────────
def preprocess_gdino_image(image: np.ndarray) -> np.ndarray:
    """Per-frame CPU preprocessing. Under the Triton/TAO path this resized
    + normalized to (3, 544, 960). With in-process HF the processor does
    all of that itself; this is now a pass-through. tracking_pipeline.py
    still calls it (line 253) and pairs the result with the raw frame —
    returning the input unchanged keeps the pairing semantically valid
    (raw frame == "preprocessed" view).
    """
    return image


def init_cuda_shm_pool() -> None:
    """CUDA shared-memory pool was a Triton perf optimization (avoid gRPC
    transfer cost). In-process inference has no such cost — noop."""
    return


def acquire_cuda_shm() -> tuple | None:
    """No-op stub. Triton-era CUDA shared-memory pool is unused."""
    return None


def release_cuda_shm(item: tuple | None) -> None:
    """No-op stub. Triton-era CUDA shared-memory pool is unused."""
    return


# ─── Compat shims ───────────────────────────────────────────────────────────
# The lifted code includes a Triton client + a BERT tokenizer accessor. Both
# are dead code on the in-process HF path but tracker.py imports get_triton_client
# (used to talk to the reid model, which IS on Triton). Keep the symbol.

_triton_client = None
_triton_lock = threading.Lock()


def get_triton_client():
    """Triton client — still used by tracker.py for the Re-ID model.
    GDINO no longer goes through this client."""
    global _triton_client  # noqa: PLW0603
    if _triton_client is None:
        with _triton_lock:
            if _triton_client is None:
                import tritonclient.grpc as grpcclient  # noqa: PLC0415

                _triton_client = grpcclient.InferenceServerClient(url=TRITON_GRPC_URL)
    return _triton_client


def get_triton_tokenizer():
    """Unused on the HF path (the HF processor handles tokenization).
    Kept for import-compat with any callers that still reach for it."""
    from transformers import AutoTokenizer  # noqa: PLC0415

    return AutoTokenizer.from_pretrained("bert-base-uncased")


def tokenize_for_triton(prompt: str) -> dict:  # noqa: ARG001
    """Compat shim — Triton-shaped tokenization is no longer needed; the
    HF processor builds the right tensors per-batch internally."""
    return {}


def nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    """Standard greedy NMS — preserved verbatim because tracking_pipeline.py
    and downstream callers use it to dedup detections before tracking."""
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        iou = inter / (areas[i] + areas[rest] - inter)
        order = rest[iou <= iou_threshold]
    return keep


# ─── HF inference: submit batch + collect detections ───────────────────────
def _run_batch_sync(images: list[np.ndarray], prompt: str) -> Any:
    """Synchronous batched HF forward. Returns the post-processed result
    list (one dict per image) so the collect-side just shapes Detection
    objects."""
    import torch  # noqa: PLC0415

    _ensure_hf_loaded()
    assert _hf_processor is not None and _hf_model is not None

    # HF GroundingDINO expects text with all classes period-separated and
    # lowercased ("a person. a dog.") — TAO uses the same shape so we pass
    # the caller's prompt through unmodified.
    text_batch = [prompt] * len(images)
    pil_images = [_np_hwc_to_pil(img) for img in images]
    inputs = _hf_processor(images=pil_images, text=text_batch, return_tensors="pt").to(_hf_device)

    with torch.no_grad():
        outputs = _hf_model(**inputs)

    # post_process returns boxes already in pixel coords for the target_sizes
    # we hand it. We use the original frame's (h, w) so downstream code gets
    # bbox_xyxy in the same pixel space as the raw frame.
    target_sizes = torch.tensor([(img.shape[0], img.shape[1]) for img in images], device=_hf_device)
    results = _hf_processor.post_process_grounded_object_detection(
        outputs,
        inputs.input_ids,
        box_threshold=HF_BOX_THRESHOLD,
        text_threshold=HF_TEXT_THRESHOLD,
        target_sizes=target_sizes,
    )
    return results  # list of dicts with keys: scores, labels, boxes


def _np_hwc_to_pil(image: np.ndarray):
    """Convert HWC uint8 RGB numpy → PIL. HF processor accepts PIL or numpy
    (HWC). PIL avoids the format-detection codepath in older transformers."""
    from PIL import Image  # noqa: PLC0415

    if image.dtype != np.uint8:
        # tracking_pipeline decodes ffmpeg frames as uint8; defensive.
        image = image.astype(np.uint8)
    return Image.fromarray(image, mode="RGB")


def submit_async_infer_batch(
    preprocessed_list: list[np.ndarray],
    prompt: str,
    shm_buf: tuple | None = None,  # noqa: ARG001 — kept for signature compat
) -> Future:
    """Submit a detection batch. The "async" terminology is historical;
    we run synchronously on a worker thread and return the Future for
    drop-in compatibility with the Triton async_infer pattern.

    `preprocessed_list` is a list of HWC uint8 RGB numpy arrays (the
    `preprocess_gdino_image` identity-pass makes this true). All frames
    in one call must share dimensions — tracking_pipeline already chunks
    by shot, so this holds.
    """
    _ensure_hf_loaded()
    assert _executor is not None
    return _executor.submit(_run_batch_sync, preprocessed_list, prompt)


def collect_batch_detections(
    future: Future,
    *,
    batch_size: int,  # noqa: ARG001 — kept for compat; we use len(result)
    width: int,  # noqa: ARG001 — HF already scaled to per-frame target_sizes
    height: int,  # noqa: ARG001
    threshold: float,
    nms_threshold: float,
    prompt: str,  # noqa: ARG001 — labels are returned by HF directly
) -> list[list[Detection]]:
    """Convert the Future's HF post-processed result into per-frame
    Detection lists. We re-apply the caller's threshold (HF's box_threshold
    is a coarser pre-filter at the model level) and NMS for parity with
    the Triton path's downstream filtering.
    """
    results = future.result()
    out: list[list[Detection]] = []
    for per_image in results:
        scores = per_image["scores"].detach().cpu().numpy()
        boxes = per_image["boxes"].detach().cpu().numpy()  # (N, 4) xyxy already in pixels
        labels = per_image["labels"]  # list[str] — phrases from the prompt

        if len(scores) == 0:
            out.append([])
            continue

        mask = scores >= threshold
        if not mask.any():
            out.append([])
            continue

        idxs = np.where(mask)[0]
        kept_boxes = boxes[idxs]
        kept_scores = scores[idxs]
        keep_after_nms = nms(kept_boxes, kept_scores, nms_threshold)

        detections: list[Detection] = []
        for k in keep_after_nms:
            local_idx = idxs[k]
            detections.append(
                Detection(
                    bbox_xyxy=[float(v) for v in kept_boxes[k]],
                    confidence=float(kept_scores[k]),
                    label=str(labels[local_idx]) if local_idx < len(labels) else "object",
                )
            )
        out.append(detections)
    return out


# ─── Server lifecycle ──────────────────────────────────────────────────────
def preload_runtime() -> None:
    """Warm the HF model + reid Triton state. Called by server.py's startup
    event so the first /invocations request doesn't pay the load cost."""
    logger.info("Preloading inference runtime")
    _ensure_hf_loaded()

    # Re-ID is still served by Triton; warm tracker's reid client + shm pool.
    from .tracker import init_reid_cuda_shm  # noqa: PLC0415

    init_reid_cuda_shm(num_buffers=MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES)

    # Sanity batch through HF on a single 1px frame to JIT-compile any
    # lazy ops in the model graph. Cheap and front-loads the first-real-
    # request latency. Wraps in try because failure here shouldn't kill
    # startup (the real /invocations call will surface the same error).
    try:
        warm = np.zeros((64, 64, 3), dtype=np.uint8)
        warmup = submit_async_infer_batch([warm], DEFAULT_PROMPT).result()
        logger.info("HF warm-up complete: %d images", len(warmup))
    except Exception:
        logger.warning("HF warm-up failed (non-fatal)", exc_info=True)


def check_health() -> None:
    """Health probe. Fails loudly if either the HF model or the reid
    Triton model isn't reachable."""
    if _hf_model is None:
        raise RuntimeError("HF GroundingDINO not loaded")

    # Re-ID still gated by Triton readiness.
    client = get_triton_client()
    if not client.is_server_live():
        raise RuntimeError("Triton server is not live")
    # GDINO model on Triton no longer exists; only check reid.
    from .config import REID_MODEL_NAME  # noqa: PLC0415

    if not client.is_model_ready(REID_MODEL_NAME):
        raise RuntimeError(f"Re-ID model {REID_MODEL_NAME} is not ready on Triton")
