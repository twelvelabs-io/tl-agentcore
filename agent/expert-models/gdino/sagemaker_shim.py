"""SageMaker BYOC adapter for the Grounding DINO service.

SageMaker hosting requires the container to expose two routes on :8080:

  GET  /ping          → 200 when healthy
  POST /invocations   → accept inference body, return response

The underlying service already exposes:

  GET  /health                      → Triton-backed health
  POST /extract_patch_candidates    → typed body + response

We mount thin aliases here without modifying the lifted `service/` tree, so
future updates from tl-embed land cleanly. The body schema is identical to
`/extract_patch_candidates`; the response is the same `ExtractPatchCandidates
Response`. SageMaker doesn't impose a wire format beyond JSON-in / JSON-out.

This module is the container's CMD entrypoint. start.sh launches Triton and
then `uvicorn sagemaker_shim:app`. The shim imports the lifted `service.server.app`
and decorates it; we don't fork the underlying FastAPI app.
"""

from __future__ import annotations

from fastapi import HTTPException

from service.schemas import ExtractPatchCandidatesRequest, ExtractPatchCandidatesResponse
from service.server import app, extract_patch_candidates as _extract_patch_candidates, health as _health


@app.get("/ping")
async def ping():
    """SageMaker health probe. Return 200 when the backend is warm.

    SageMaker only checks status_code 200; the body is informational. The
    underlying /health response is a mixed-type dict (ints + strs), so we
    explicitly drop the response_model and return-type hint here to skip
    FastAPI's automatic response_model coercion (which would otherwise
    raise ResponseValidationError on the int fields and 500 the probe).
    """
    try:
        return await _health()
    except HTTPException:
        # Re-raise; FastAPI will translate to the right status code, which
        # SageMaker reads as "container unhealthy" and won't dispatch
        # /invocations against.
        raise


@app.post("/invocations", response_model=ExtractPatchCandidatesResponse)
def invocations(req: ExtractPatchCandidatesRequest) -> ExtractPatchCandidatesResponse:
    """SageMaker inference route. Delegates to the existing typed handler."""
    return _extract_patch_candidates(req)
