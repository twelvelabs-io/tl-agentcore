#!/usr/bin/env python3
"""Stage knowledge-store assets into CLIPS_BUCKET as mp4 files.

The downstream ingest pipelines (`ingest_vectors.py`,
`ingest_entity_thumbs.py`, the Phase 3-proper Re-ID Step Functions
workflow, the runtime `pegasus_analyze` Bedrock path) all assume each
asset's bytes live at:

    s3://<CLIPS_BUCKET>/clips/<asset_id>.mp4

TwelveLabs exposes assets only as HLS playlists (no direct mp4 URL),
so we use ffmpeg in stream-copy mode (`-c copy`) to re-mux the HLS
segments into a single mp4 without re-encoding — fast and lossless.

Idempotent: skip assets whose object already exists in S3 unless
`--force` is passed.

Usage:
  export CLIPS_BUCKET_NAME=$(terraform -chdir=infra output -raw clips_bucket_name)
  AWS_PROFILE=... TL_API_KEY=tlk_... \\
    python3 scripts/stage_clips_to_s3.py ks_<id> [--limit N] [--workers 4]

Requires `ffmpeg` on PATH (brew install ffmpeg / apt install ffmpeg).
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import httpx

TL_BASE = os.environ.get("TL_BASE_URL", "https://api.twelvelabs.io/v1.3")
TL_KEY = os.environ.get("TL_API_KEY")
REGION = os.environ.get("AWS_REGION", "us-east-1")
CLIPS_BUCKET = os.environ.get("CLIPS_BUCKET_NAME")

if not TL_KEY:
    print("error: TL_API_KEY env var required", file=sys.stderr)
    sys.exit(2)
if not CLIPS_BUCKET:
    print("error: CLIPS_BUCKET_NAME env var required", file=sys.stderr)
    sys.exit(2)
if not shutil.which("ffmpeg"):
    print("error: ffmpeg must be on PATH (brew install ffmpeg)", file=sys.stderr)
    sys.exit(2)

s3 = boto3.client("s3", region_name=REGION)


def list_ks_items(ks_id: str, limit: int | None) -> list[dict]:
    """Page through /knowledge-stores/<id>/items, return up to `limit`."""
    out: list[dict] = []
    page = 1
    while True:
        with httpx.Client(timeout=60) as c:
            r = c.get(
                f"{TL_BASE}/knowledge-stores/{ks_id}/items",
                headers={"x-api-key": TL_KEY},
                params={"page_limit": 50, "page": page},
            )
        r.raise_for_status()
        j = r.json()
        data = j.get("data") or []
        out.extend(data)
        if limit and len(out) >= limit:
            return out[:limit]
        pi = j.get("page_info") or {}
        if not data or page >= (pi.get("total_page") or 1):
            break
        page += 1
    return out[: limit] if limit else out


def already_staged(asset_id: str) -> bool:
    try:
        s3.head_object(Bucket=CLIPS_BUCKET, Key=f"clips/{asset_id}.mp4")
        return True
    except Exception:
        return False


def get_hls_url(asset_id: str) -> str | None:
    """Fetch the asset's HLS manifest URL. Some old assets may lack HLS
    (status != 'ready'); skip those — re-staging them needs a different
    download path that's not implemented here."""
    with httpx.Client(timeout=60) as c:
        r = c.get(
            f"{TL_BASE}/assets/{asset_id}",
            headers={"x-api-key": TL_KEY},
        )
    if r.status_code >= 400:
        return None
    j = r.json()
    hls = j.get("hls") or {}
    if hls.get("status") != "ready":
        return None
    return hls.get("manifest_url")


def stage_one(asset_id: str, tmpdir: str, force: bool) -> dict:
    """HLS → local mp4 (ffmpeg stream-copy) → S3."""
    if not force and already_staged(asset_id):
        return {"asset_id": asset_id, "status": "skipped"}

    hls_url = get_hls_url(asset_id)
    if not hls_url:
        return {"asset_id": asset_id, "status": "no_hls"}

    local_path = os.path.join(tmpdir, f"{asset_id}.mp4")
    # Stream-copy avoids the CPU cost of re-encoding. The `aac_adtstoasc`
    # bitstream filter is needed because HLS audio is wrapped in ADTS but
    # mp4 wants the bare AAC frames.
    cmd = [
        "ffmpeg", "-y",
        "-headers", "User-Agent: tl-agentcore-stage-clips/1.0\r\n",
        "-i", hls_url,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        local_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=600)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace")[-300:]
        return {"asset_id": asset_id, "status": "ffmpeg_failed", "error": err}

    size = os.path.getsize(local_path)
    if size < 1000:
        return {"asset_id": asset_id, "status": "tiny_output", "size": size}

    try:
        s3.upload_file(local_path, CLIPS_BUCKET, f"clips/{asset_id}.mp4",
                       ExtraArgs={"ContentType": "video/mp4"})
    except Exception as e:
        return {"asset_id": asset_id, "status": "upload_failed", "error": str(e)[:200]}

    try:
        os.remove(local_path)
    except Exception:
        pass

    return {"asset_id": asset_id, "status": "ok", "size_mb": round(size / 1_000_000, 2)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ks_id")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap how many assets to stage (default: all).")
    ap.add_argument("--workers", type=int, default=4,
                    help="Parallel ffmpeg→S3 workers (default 4). Each holds "
                         "an HLS read + S3 upload, so network is the bottleneck.")
    ap.add_argument("--force", action="store_true",
                    help="Re-stage even if the object already exists in S3.")
    args = ap.parse_args()

    print(f"→ listing items in {args.ks_id}")
    items = list_ks_items(args.ks_id, args.limit)
    print(f"  {len(items)} items to consider")

    asset_ids: list[str] = []
    for it in items:
        aid = it.get("asset_id") or ""
        if aid:
            asset_ids.append(aid)

    if not asset_ids:
        print("  no asset_ids; nothing to stage")
        return 0

    print(f"→ staging up to {len(asset_ids)} assets with {args.workers} workers")
    ok = skipped = failed = 0
    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmpdir:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futs = {pool.submit(stage_one, aid, tmpdir, args.force): aid for aid in asset_ids}
            for n, fut in enumerate(as_completed(futs), 1):
                r = fut.result()
                aid = r["asset_id"]
                status = r.get("status")
                if status == "ok":
                    ok += 1
                    print(f"  [{n}/{len(asset_ids)}] {aid[:12]} ✓ {r.get('size_mb')} MB")
                elif status == "skipped":
                    skipped += 1
                    print(f"  [{n}/{len(asset_ids)}] {aid[:12]} • already in S3")
                else:
                    failed += 1
                    err = (r.get("error") or "").replace("\n", " ")[:120]
                    print(f"  [{n}/{len(asset_ids)}] {aid[:12]} ✗ {status} {err}")

    elapsed = time.time() - t0
    print(f"\n→ staged {ok} · skipped {skipped} · failed {failed} · {elapsed:.1f}s")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
