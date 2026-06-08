"""Build the S3 Vectors index for a knowledge store, AWS-native.

This script only talks to AWS: S3, Bedrock, S3 Vectors. Operators stage
asset bytes into the clips bucket beforehand (setup_test_fixtures.sh does
this automatically for the demo data; for production data the operator
syncs source media into s3://<CLIPS_BUCKET>/clips/<asset_id>.mp4 via
whatever pipeline they already use).

Pipeline per asset:
  1. Confirm s3://<CLIPS_BUCKET>/clips/<asset_id>.mp4 exists.
  2. Submit a Bedrock async invoke against twelvelabs.marengo-embed-3-0-v1:0
     with the s3Location. Output lands under s3://<CLIPS_BUCKET>/embeddings/
     <invocation_id>/output.json.
  3. Read the output, take the clip-scope segments, and upsert them into
     the S3 Vectors index with metadata
     {asset_id, knowledge_store_id, start_sec, end_sec, s3_uri}.

The TL API key is only used to enumerate assets in the knowledge store
(KS is the namespace abstraction). For deployments that do not use a TL
KS, pass --asset-id repeatedly instead.

Usage:
    export CLIPS_BUCKET_NAME=tl-agentcore-<stack>-clips
    export VECTOR_BUCKET_NAME=tl-agentcore-<stack>-clips
    export VECTOR_INDEX_NAME=clips
    export TL_API_KEY=tlk_...                       # only for KS asset listing
    export AWS_REGION=us-east-1
    python scripts/ingest_vectors.py ks_<id>

Re-running is idempotent: StartAsyncInvoke re-embeds; PutVectors upserts.
"""

from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
import httpx

TL_BASE = os.environ.get("TL_BASE_URL", "https://api.twelvelabs.io/v1.3")
MARENGO_MODEL_ID = os.environ.get(
    "MARENGO_BEDROCK_MODEL_ID",
    "twelvelabs.marengo-embed-3-0-v1:0",
)
PUT_BATCH = 500
PARALLEL = 4   # concurrent Bedrock async invocations
POLL_INTERVAL = 6
POLL_DEADLINE_SEC = 30 * 60


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("ks_id")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap number of assets to embed (default: all). Useful "
                         "for bounded test runs against large knowledge stores.")
    args = ap.parse_args()
    ks_id = args.ks_id
    api_key = os.environ.get("TL_API_KEY")
    clips_bucket = os.environ.get("CLIPS_BUCKET_NAME")
    vector_bucket = os.environ.get("VECTOR_BUCKET_NAME")
    vector_index = os.environ.get("VECTOR_INDEX_NAME", "clips")
    region = os.environ.get("AWS_REGION", "us-east-1")

    missing = [n for n, v in [
        ("TL_API_KEY", api_key),
        ("CLIPS_BUCKET_NAME", clips_bucket),
        ("VECTOR_BUCKET_NAME", vector_bucket),
    ] if not v]
    if missing:
        print(f"ERROR: required env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    s3 = boto3.client("s3", region_name=region)
    s3v = boto3.client("s3vectors", region_name=region)
    br = boto3.client("bedrock-runtime", region_name=region)
    tl = httpx.Client(timeout=180, headers={"x-api-key": api_key})

    print(f"==> listing assets in {ks_id}")
    assets = list(_list_ks_assets(tl, ks_id))
    print(f"    {len(assets)} assets found")
    if args.limit:
        assets = assets[: args.limit]
        print(f"    limited to {len(assets)} (--limit)")
    if not assets:
        return 0

    bucket_owner = boto3.client("sts", region_name=region).get_caller_identity()["Account"]
    print(f"==> ingesting {len(assets)} assets ({PARALLEL} concurrent)")
    all_vectors: list[dict] = []
    failures = 0
    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        futures = {
            ex.submit(_ingest_one, s3, br, clips_bucket, a, ks_id, bucket_owner): a
            for a in assets
        }
        for i, f in enumerate(as_completed(futures), 1):
            a = futures[f]
            try:
                vecs = f.result()
                all_vectors.extend(vecs)
                print(f"    [{i}/{len(assets)}] {a}: {len(vecs)} clip vectors")
            except Exception as e:
                failures += 1
                print(f"    [{i}/{len(assets)}] {a}: FAILED ({e})", file=sys.stderr)

    if failures:
        print(f"==> {failures} assets failed; continuing with {len(all_vectors)} vectors")
    if not all_vectors:
        print("ERROR: nothing to write", file=sys.stderr)
        return 1

    print(f"==> writing {len(all_vectors)} vectors to s3vectors://{vector_bucket}/{vector_index}")
    written = 0
    for batch in _chunks(all_vectors, PUT_BATCH):
        s3v.put_vectors(vectorBucketName=vector_bucket, indexName=vector_index, vectors=batch)
        written += len(batch)
        print(f"    PutVectors {written}/{len(all_vectors)}")

    print("Done.")
    return 0


def _list_ks_assets(tl: httpx.Client, ks_id: str):
    """Yield asset_id for every item in the knowledge store."""
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


def _ingest_one(
    s3,
    br,
    clips_bucket: str,
    asset_id: str,
    ks_id: str,
    bucket_owner: str,
) -> list[dict]:
    """Run Bedrock Marengo embed against the mirrored asset in S3 and
    return the list of S3 Vectors upsert-shaped dicts."""
    s3_key = f"clips/{asset_id}.mp4"
    s3_uri = f"s3://{clips_bucket}/{s3_key}"

    if not _s3_object_exists(s3, clips_bucket, s3_key):
        raise RuntimeError(
            f"{s3_uri} not found; stage the asset bytes before ingest "
            f"(see setup_test_fixtures.sh for the demo flow)"
        )
    invocation = br.start_async_invoke(
        modelId=MARENGO_MODEL_ID,
        modelInput={
            "inputType": "video",
            "video": {
                "mediaSource": {
                    "s3Location": {"uri": s3_uri, "bucketOwner": bucket_owner}
                }
            },
        },
        outputDataConfig={
            "s3OutputDataConfig": {
                "s3Uri": f"s3://{clips_bucket}/embeddings/",
            }
        },
    )
    arn = invocation["invocationArn"]
    inv_id = arn.rsplit("/", 1)[-1]

    deadline = time.time() + POLL_DEADLINE_SEC
    while True:
        if time.time() > deadline:
            raise RuntimeError(f"async invoke {inv_id} did not finish in {POLL_DEADLINE_SEC}s")
        meta = br.get_async_invoke(invocationArn=arn)
        status = meta.get("status")
        if status == "Completed":
            break
        if status == "Failed":
            raise RuntimeError(f"async invoke failed: {meta.get('failureMessage')}")
        time.sleep(POLL_INTERVAL)

    out_obj = s3.get_object(Bucket=clips_bucket, Key=f"embeddings/{inv_id}/output.json")
    data = json.loads(out_obj["Body"].read())

    out: list[dict] = []
    for i, seg in enumerate(data.get("data") or []):
        if seg.get("embeddingScope") != "clip":
            continue
        emb = seg.get("embedding") or []
        if not emb:
            continue
        start = int(seg.get("startSec") or 0)
        end = int(seg.get("endSec") or 0)
        out.append({
            "key": f"{asset_id}:{start}:{end}:{i}",
            "data": {"float32": emb},
            "metadata": {
                "asset_id":           asset_id,
                "knowledge_store_id": ks_id,
                "start_sec":          start,
                "end_sec":            end,
                "s3_uri":             s3_uri,
            },
        })
    return out


def _s3_object_exists(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except s3.exceptions.ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


if __name__ == "__main__":
    sys.exit(main())
