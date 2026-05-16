"""Build the S3 Vectors index for a TwelveLabs knowledge store.

Lists every asset in the KS, submits a Marengo `embed-v2/tasks` job per
asset (referenced by `asset_id`), polls until ready, and writes the
resulting clip embeddings to the S3 Vector index. Each vector carries
metadata so the agent's `vector_search` tool can filter to the right
knowledge store at query time:

    asset_id, knowledge_store_id, start_sec, end_sec

Usage:
    export TL_API_KEY=tlk_...
    export VECTOR_BUCKET_NAME=tl-agentcore-<stack>-clips
    export VECTOR_INDEX_NAME=clips                       # default
    export AWS_REGION=us-east-1
    python scripts/ingest_vectors.py ks_<id>

Throughput is gated by Marengo's embedding queue (each task takes seconds
for a short clip, minutes for a long asset). Indexed once per KS; safe to
re-run idempotently (PutVectors is upsert by key).
"""

from __future__ import annotations

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import httpx

TL_BASE = os.environ.get("TL_BASE_URL", "https://api.twelvelabs.io/v1.3")
EMBED_MODEL = os.environ.get("MARENGO_EMBED_MODEL", "marengo3.0")
PUT_BATCH = 500       # S3 Vectors PutVectors max items per call
PARALLEL = 6          # how many concurrent Marengo embed tasks


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python ingest_vectors.py <knowledge_store_id>")
        return 2

    ks_id = sys.argv[1]
    api_key = os.environ.get("TL_API_KEY")
    bucket = os.environ.get("VECTOR_BUCKET_NAME")
    index = os.environ.get("VECTOR_INDEX_NAME", "clips")
    region = os.environ.get("AWS_REGION", "us-east-1")
    if not api_key:
        print("ERROR: TL_API_KEY env var required", file=sys.stderr)
        return 1
    if not bucket:
        print("ERROR: VECTOR_BUCKET_NAME env var required (terraform output vector_bucket_name)", file=sys.stderr)
        return 1

    s3v = boto3.client("s3vectors", region_name=region)
    tl = httpx.Client(timeout=120, headers={"x-api-key": api_key})

    print(f"==> listing assets in {ks_id}")
    asset_ids = list(_list_ks_assets(tl, ks_id))
    print(f"    {len(asset_ids)} assets found")
    if not asset_ids:
        print("    nothing to ingest")
        return 0

    print(f"==> embedding {len(asset_ids)} assets via Marengo ({PARALLEL} concurrent)")
    all_vectors: list[dict] = []
    failures = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        futures = {ex.submit(_embed_asset, tl, aid, ks_id): aid for aid in asset_ids}
        for i, f in enumerate(as_completed(futures), 1):
            aid = futures[f]
            try:
                vecs = f.result()
                all_vectors.extend(vecs)
                print(f"    [{i}/{len(asset_ids)}] {aid}: {len(vecs)} clip vectors")
            except Exception as e:
                failures += 1
                print(f"    [{i}/{len(asset_ids)}] {aid}: FAILED ({e})", file=sys.stderr)

    if failures:
        print(f"==> {failures} assets failed to embed; continuing with {len(all_vectors)} vectors")

    if not all_vectors:
        print("ERROR: nothing to write to the index", file=sys.stderr)
        return 1

    print(f"==> writing {len(all_vectors)} vectors to s3vectors://{bucket}/{index}")
    written = 0
    for batch in _chunks(all_vectors, PUT_BATCH):
        s3v.put_vectors(
            vectorBucketName=bucket,
            indexName=index,
            vectors=batch,
        )
        written += len(batch)
        print(f"    PutVectors {written}/{len(all_vectors)}")

    print("Done.")
    return 0


def _list_ks_assets(tl: httpx.Client, ks_id: str):
    """Yield every asset_id in the knowledge store, paginated."""
    next_token = None
    while True:
        params: dict = {"page_limit": 50}
        if next_token:
            params["next_page_token"] = next_token
        r = tl.get(f"{TL_BASE}/knowledge-stores/{ks_id}/items", params=params)
        r.raise_for_status()
        j = r.json()
        for item in j.get("data", []):
            aid = item.get("asset_id")
            if aid:
                yield aid
        next_token = (j.get("page_info") or {}).get("next_page_token")
        if not next_token:
            break


def _embed_asset(tl: httpx.Client, asset_id: str, ks_id: str) -> list[dict]:
    """Submit a Marengo embed-v2 task for one asset, poll until ready,
    return the list of PutVectors-shaped dicts ready for upsert.
    """
    body = {
        "input_type": "video",
        "model_name": EMBED_MODEL,
        "video": {
            "media_source": {"type": "asset_id", "asset_id": asset_id},
        },
    }
    r = tl.post(f"{TL_BASE}/embed-v2/tasks", json=body)
    if r.status_code >= 400:
        raise RuntimeError(f"submit task {r.status_code}: {r.text[:300]}")
    task_id = r.json()["_id"]

    # Poll. Short assets finish in seconds; long ones in minutes.
    deadline = time.time() + 30 * 60
    j: dict = {}
    while True:
        if time.time() > deadline:
            raise RuntimeError(f"task {task_id} did not finish in 30 min")
        r = tl.get(f"{TL_BASE}/embed-v2/tasks/{task_id}")
        r.raise_for_status()
        j = r.json()
        status = j.get("status")
        if status == "ready":
            break
        if status == "failed":
            raise RuntimeError(f"task {task_id} failed: {j}")
        time.sleep(8)

    out = []
    for i, seg in enumerate(j.get("data") or []):
        if seg.get("embedding_scope") != "clip":
            continue  # asset-scope segments cover the whole video; we only index clips
        embedding = seg.get("embedding") or []
        if not embedding:
            continue
        out.append({
            "key": f"{asset_id}:{int(seg.get('start_sec') or 0)}:{int(seg.get('end_sec') or 0)}:{i}",
            "data": {"float32": embedding},
            "metadata": {
                "asset_id":           asset_id,
                "knowledge_store_id": ks_id,
                "start_sec":          int(seg.get("start_sec") or 0),
                "end_sec":            int(seg.get("end_sec")   or 0),
            },
        })
    return out


def _chunks(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


if __name__ == "__main__":
    sys.exit(main())
