"""SageMaker Processing Job entrypoint for the GDINO entity-Re-ID pipeline.

Run inside the same container as the SageMaker hosting path
(`sagemaker_shim.py`), but instead of serving HTTP we read inputs from the
Processing Job mount points, run the pipeline once, write outputs, and exit.
Triton + the FastAPI server are NOT started in this mode — we call the
in-process functions directly. (Triton is required, though, because
`tracking_pipeline.extract_patch_candidates` invokes it for detection +
Re-ID. The wrapper `processing.sh` starts Triton in the background before
invoking this script.)

SageMaker Processing Job contract:
  /opt/ml/processing/input/<channel>/...   ← downloaded from S3 at start
  /opt/ml/processing/output/<channel>/...  ← uploaded to S3 on exit

We use two input channels:
  config/   one file: request.json (the ExtractPatchCandidatesRequest body
            minus video_path; we wire video_path to the local mp4 below)
  video/    one file: <asset_id>.mp4

And one output channel:
  result/   patch_candidates.json (the full ExtractPatchCandidatesResponse,
            including base64 JPEG crops keyed by instance_id)

The orchestrator Step Functions reads this output, Titan-embeds each
patch_b64, and upserts into the entity_patches S3 Vectors index plus
the kb_cache ENTITY# records.
"""

from __future__ import annotations

import glob
import json
import logging
import os
import sys
from pathlib import Path

from service.schemas import ExtractPatchCandidatesRequest
from service.tracking_pipeline import extract_patch_candidates
from service.triton_backend import preload_runtime

INPUT_ROOT = Path(os.environ.get("SM_PROCESSING_INPUT_DIR", "/opt/ml/processing/input"))
OUTPUT_ROOT = Path(os.environ.get("SM_PROCESSING_OUTPUT_DIR", "/opt/ml/processing/output"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("processing_entrypoint")


def _read_request() -> dict:
    cfg_path = INPUT_ROOT / "config" / "request.json"
    if not cfg_path.exists():
        raise FileNotFoundError(f"missing config input: {cfg_path}")
    with cfg_path.open() as f:
        body = json.load(f)
    return body


def _resolve_video() -> str:
    """Single .mp4 expected under input/video/. Returns local path the
    pipeline can hand to ffmpeg directly — avoids a redundant s3 download
    inside the container."""
    videos = sorted(glob.glob(str(INPUT_ROOT / "video" / "*.mp4")))
    if not videos:
        raise FileNotFoundError(f"no .mp4 found under {INPUT_ROOT/'video'}")
    if len(videos) > 1:
        log.warning("multiple .mp4 files in input/video/; using first: %s", videos[0])
    return videos[0]


def _write_response(resp_dict: dict) -> Path:
    out_dir = OUTPUT_ROOT / "result"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "patch_candidates.json"
    with out_path.open("w") as f:
        json.dump(resp_dict, f)
    return out_path


def main() -> int:
    log.info("preloading Triton runtime (gdino + reid)...")
    preload_runtime()
    log.info("runtime ready")

    body = _read_request()
    body["video_path"] = _resolve_video()
    log.info("request: text_prompt=%r fps=%s video=%s", body.get("text_prompt"), body.get("fps"), body["video_path"])

    req = ExtractPatchCandidatesRequest(**body)
    resp = extract_patch_candidates(req)
    resp_dict = resp.model_dump() if hasattr(resp, "model_dump") else resp.dict()

    out_path = _write_response(resp_dict)
    log.info(
        "wrote %d patch candidates · %d reference patches · %.2fs · %s",
        len(resp_dict.get("patch_candidates", [])),
        len(resp_dict.get("reference_patches", []) or []),
        resp_dict.get("elapsed_s", 0.0),
        out_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
