#!/usr/bin/env python3
"""Build the entity-thumbnail vector index for a TwelveLabs knowledge store.

Phase 3 (AWS-native Re-ID): for each cached asset, extract N representative
frames via ffmpeg, embed each through Bedrock Titan Multimodal Embeddings,
upsert into the S3 Vectors `entity-thumbs` index. Queries at runtime go
through the agent's `find_entity_by_image` tool — O(log N) ANN lookup on a
1024-dim space, no per-clip iteration.

Per-asset pipeline:
  1. Download s3://CLIPS_BUCKET/clips/<asset_id>.mp4 to /tmp.
  2. Use ffprobe to get duration; pick N timestamps (default 10%/30%/50%/70%/90%).
  3. ffmpeg -ss <t> -i ... -frames:v 1 → JPEG.
  4. Upload JPEG to s3://CLIPS_BUCKET/thumbs/<asset_id>/<idx>.jpg.
  5. Bedrock Titan invoke → 1024-dim vector.
  6. S3 Vectors put_vectors with metadata {asset_id, knowledge_store_id,
     frame_idx, frame_pct, frame_s3_uri}.

Reads asset_ids from kb_cache (populated by ingest_kb_cache.py).

Usage:
  export VECTOR_BUCKET_NAME=$(terraform -chdir=infra output -raw vector_bucket_name)
  export VECTOR_INDEX_ENTITY_THUMBS=$(terraform -chdir=infra output -raw vector_index_entity_thumbs)
  export CLIPS_BUCKET_NAME=$(terraform -chdir=infra output -raw clips_bucket_name)
  export KB_CACHE_TABLE=$(terraform -chdir=infra output -raw kb_cache_table)
  AWS_PROFILE=... python3 scripts/ingest_entity_thumbs.py ks_<id> [--frames 5] [--workers 4]

Requires `ffmpeg` and `ffprobe` on PATH (brew install ffmpeg).
Idempotent: existing frame keys are overwritten; existing vector keys are upserted.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import boto3

VECTOR_BUCKET = os.environ.get("VECTOR_BUCKET_NAME")
VECTOR_INDEX  = os.environ.get("VECTOR_INDEX_ENTITY_THUMBS", "entity-thumbs")
CLIPS_BUCKET  = os.environ.get("CLIPS_BUCKET_NAME")
KB_CACHE      = os.environ.get("KB_CACHE_TABLE")
REGION        = os.environ.get("AWS_REGION", "us-east-1")
TITAN_MODEL   = os.environ.get("TITAN_IMAGE_EMBED_MODEL_ID", "amazon.titan-embed-image-v1")

if not (VECTOR_BUCKET and CLIPS_BUCKET and KB_CACHE):
    print("error: VECTOR_BUCKET_NAME, CLIPS_BUCKET_NAME, KB_CACHE_TABLE env vars required", file=sys.stderr)
    sys.exit(2)

if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
    print("error: ffmpeg + ffprobe must be on PATH (brew install ffmpeg)", file=sys.stderr)
    sys.exit(2)

s3 = boto3.client("s3", region_name=REGION)
ddb = boto3.client("dynamodb", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)
s3v = boto3.client("s3vectors", region_name=REGION)


def list_kb_asset_ids(ks_id: str) -> list[str]:
    """Read asset_ids from the kb_cache. Falls back to empty list if the
    cache hasn't been built yet — caller is expected to run ingest_kb_cache
    first."""
    out: list[str] = []
    page: dict | None = None
    while True:
        kwargs: dict = {
            "TableName": KB_CACHE,
            "KeyConditionExpression": "pk = :p AND begins_with(sk, :s)",
            "ExpressionAttributeValues": {":p": {"S": f"ks#{ks_id}"}, ":s": {"S": "ASSET#"}},
            "ProjectionExpression": "asset_id",
        }
        if page:
            kwargs["ExclusiveStartKey"] = page
        r = ddb.query(**kwargs)
        for it in r.get("Items", []):
            aid = (it.get("asset_id") or {}).get("S")
            if aid:
                out.append(aid)
        page = r.get("LastEvaluatedKey")
        if not page:
            break
    return out


def probe_duration(local_path: str) -> float:
    """ffprobe → duration in seconds."""
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", local_path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return float(r.stdout.strip() or "0")


def extract_frame(local_mp4: str, t_seconds: float, out_jpg: str) -> None:
    """ffmpeg -ss before -i → fast keyframe seek, then extract one frame."""
    cmd = [
        "ffmpeg", "-y", "-ss", f"{t_seconds:.3f}", "-i", local_mp4,
        "-frames:v", "1", "-q:v", "3", out_jpg,
    ]
    subprocess.run(cmd, capture_output=True, check=True)


def titan_embed(jpg_bytes: bytes) -> list[float]:
    body = {
        "inputImage": base64.b64encode(jpg_bytes).decode("ascii"),
        "embeddingConfig": {"outputEmbeddingLength": 1024},
    }
    resp = bedrock.invoke_model(
        modelId=TITAN_MODEL,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
    )
    payload = json.loads(resp["body"].read())
    return payload["embedding"]


def process_asset(ks_id: str, asset_id: str, frame_pcts: list[float], tmpdir: str) -> dict[str, Any]:
    """Download → frame-extract → Titan-embed → upsert vectors. One asset."""
    local_mp4 = os.path.join(tmpdir, f"{asset_id}.mp4")
    try:
        s3.download_file(CLIPS_BUCKET, f"clips/{asset_id}.mp4", local_mp4)
    except Exception as e:
        return {"asset_id": asset_id, "error": f"download failed: {e}"}

    try:
        duration = probe_duration(local_mp4)
    except Exception as e:
        return {"asset_id": asset_id, "error": f"ffprobe failed: {e}"}
    if duration <= 0:
        return {"asset_id": asset_id, "error": "zero duration"}

    vectors_to_put: list[dict] = []
    for idx, pct in enumerate(frame_pcts):
        t = max(0.0, min(duration - 0.1, duration * pct))
        jpg_path = os.path.join(tmpdir, f"{asset_id}-{idx}.jpg")
        try:
            extract_frame(local_mp4, t, jpg_path)
        except subprocess.CalledProcessError as e:
            stderr = (e.stderr or b"").decode("utf-8", errors="replace")[:200]
            return {"asset_id": asset_id, "error": f"ffmpeg failed at {t:.1f}s: {stderr}"}

        with open(jpg_path, "rb") as f:
            jpg_bytes = f.read()
        try:
            vec = titan_embed(jpg_bytes)
        except Exception as e:
            return {"asset_id": asset_id, "error": f"Titan embed failed: {e}"}

        # Mirror the frame into S3 so the agent can return a stable URL.
        thumb_key = f"thumbs/{asset_id}/{idx}.jpg"
        try:
            s3.put_object(Bucket=CLIPS_BUCKET, Key=thumb_key, Body=jpg_bytes, ContentType="image/jpeg")
        except Exception as e:
            return {"asset_id": asset_id, "error": f"thumb upload failed: {e}"}

        vectors_to_put.append({
            "key":  f"{asset_id}#{idx}",
            "data": {"float32": vec},
            "metadata": {
                "asset_id":          asset_id,
                "knowledge_store_id": ks_id,
                "frame_idx":         int(idx),
                "frame_pct":         round(pct, 3),
                "frame_s3_uri":      f"s3://{CLIPS_BUCKET}/{thumb_key}",
            },
        })

    # S3 Vectors put_vectors accepts up to 500 per call; we're well under.
    try:
        s3v.put_vectors(
            vectorBucketName=VECTOR_BUCKET,
            indexName=VECTOR_INDEX,
            vectors=vectors_to_put,
        )
    except Exception as e:
        return {"asset_id": asset_id, "error": f"put_vectors failed: {e}"}

    return {"asset_id": asset_id, "frames": len(vectors_to_put), "duration_s": round(duration, 1)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ks_id", help="Knowledge store id")
    ap.add_argument("--frames", type=int, default=5, help="Frames per asset (default 5)")
    ap.add_argument("--workers", type=int, default=4, help="Parallel asset workers")
    ap.add_argument("--limit", type=int, default=None, help="Cap number of assets")
    args = ap.parse_args()

    frame_pcts = [(i + 1) / (args.frames + 1) for i in range(args.frames)]
    print(f"→ frame positions: {[round(p, 2) for p in frame_pcts]}")

    asset_ids = list_kb_asset_ids(args.ks_id)
    if args.limit:
        asset_ids = asset_ids[: args.limit]
    print(f"→ {len(asset_ids)} cached assets to process")

    if not asset_ids:
        print("  kb_cache empty for this ks_id — run ingest_kb_cache.py first")
        return 1

    failed = 0
    written = 0
    t0 = time.time()
    with tempfile.TemporaryDirectory() as tmpdir:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            futs = {pool.submit(process_asset, args.ks_id, aid, frame_pcts, tmpdir): aid for aid in asset_ids}
            for n, fut in enumerate(as_completed(futs), 1):
                r = fut.result()
                aid = r["asset_id"]
                if r.get("error"):
                    failed += 1
                    print(f"  [{n}/{len(asset_ids)}] {aid[:12]} ✗ {r['error'][:80]}")
                else:
                    written += r.get("frames", 0)
                    print(f"  [{n}/{len(asset_ids)}] {aid[:12]} ✓ {r['frames']} frames · {r['duration_s']}s")

    elapsed = time.time() - t0
    print(f"\n→ wrote {written} vectors across {len(asset_ids) - failed} assets (failed {failed}) in {elapsed:.1f}s")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
