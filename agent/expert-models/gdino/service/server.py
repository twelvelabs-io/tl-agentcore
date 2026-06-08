"""FastAPI route layer for the Triton-backed GDINO service."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import threading

from fastapi import FastAPI, HTTPException

from .config import (
    GDINO_BATCH_SIZE,
    MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES,
    MAX_QUEUE_WAIT_SECONDS,
    TRACKER_BATCH_MULTIPLIER,
    TRACKER_TYPE,
)
from .schemas import ExtractPatchCandidatesRequest, ExtractPatchCandidatesResponse
from .tracking_pipeline import extract_patch_candidates as run_extract_patch_candidates
from .triton_backend import check_health, preload_runtime

logger = logging.getLogger(__name__)
app = FastAPI(title="Grounding DINO Expert Model")

_extract_patch_candidates_semaphore = threading.Semaphore(MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES)


@app.on_event("startup")
async def preload() -> None:
    """Warm Triton client, tokenizer, and tracker shared memory on startup.

    asyncio.to_thread is Python 3.9+; Triton 22.12 ships 3.8. Use the
    pre-3.9 equivalent (loop.run_in_executor with default executor) so
    the long-running HF model load happens off the event loop.
    """
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, preload_runtime)


@app.get("/health")
async def health() -> dict[str, object]:
    """Report Triton-backed service health."""
    try:
        check_health()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Triton health check failed: {exc}") from exc

    return {
        "status": "ok",
        "mode": "triton",
        "tracker": TRACKER_TYPE,
        "device": os.environ.get("DEVICE", "cuda"),
        "gdino_batch_size": GDINO_BATCH_SIZE,
        "tracker_batch_multiplier": TRACKER_BATCH_MULTIPLIER,
        "tracker_batch_frames": GDINO_BATCH_SIZE * TRACKER_BATCH_MULTIPLIER,
        "max_concurrent": MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES,
    }


@app.post("/extract_patch_candidates", response_model=ExtractPatchCandidatesResponse)
def extract_patch_candidates(req: ExtractPatchCandidatesRequest) -> ExtractPatchCandidatesResponse:
    """Decode a video segment, detect objects with Triton, and return patch candidates."""
    acquired = _extract_patch_candidates_semaphore.acquire(timeout=MAX_QUEUE_WAIT_SECONDS)
    if not acquired:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Queue timeout: waited {MAX_QUEUE_WAIT_SECONDS}s, "
                f"all {MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES} slots busy"
            ),
        )

    try:
        return run_extract_patch_candidates(req)
    except HTTPException:
        raise
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Video processing timed out: {exc}") from exc
    except Exception as exc:
        logger.exception("extract_patch_candidates failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Internal error: {type(exc).__name__}: {str(exc)[:500]}",
        ) from exc
    finally:
        _extract_patch_candidates_semaphore.release()
