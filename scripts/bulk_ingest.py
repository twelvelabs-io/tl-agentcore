"""Walk every TwelveLabs knowledge store and ingest its assets into the
Bedrock-native pipeline.

For every asset in every KS:
  1. If clips/<asset_id>.mp4 is already in the clips bucket, skip the
     mirror step. Otherwise download the asset's HLS manifest via ffmpeg
     and upload the concatenated mp4 to S3.
  2. If embeddings/<asset_id>/.done exists in S3, skip embedding.
     Otherwise StartAsyncInvoke against Bedrock Marengo 3.0, poll until
     the output lands, parse clip-scope segments, write a done marker.
  3. Accumulate the resulting vectors and PutVectors in batches.

Idempotent and resumable: kill it and rerun, it picks up where it left
off. Skips KSes by name via --skip-ks. Limits with --max-assets-per-ks
if you want a dry run.

Usage:
    export TL_API_KEY=...
    export CLIPS_BUCKET_NAME=tl-agentcore-<stack>-clips
    export VECTOR_BUCKET_NAME=tl-agentcore-<stack>-clips
    export VECTOR_INDEX_NAME=clips
    export AWS_REGION=us-east-1
    python scripts/bulk_ingest.py [--skip-ks "tl-agentcore-e2e"] [--max-assets-per-ks 5]

Concurrency is set per-KS. ffmpeg downloads are I/O bound; Bedrock async
invokes are throughput-gated by the service. PARALLEL=4 keeps both
reasonable without hammering either.
"""

from __future__ import annotations

import argparse
import json
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
MARENGO_MODEL_ID = os.environ.get(
    "MARENGO_BEDROCK_MODEL_ID",
    "twelvelabs.marengo-embed-3-0-v1:0",
)
PUT_BATCH = 500
PARALLEL = 4
POLL_INTERVAL = 8
POLL_DEADLINE_SEC = 30 * 60


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-ks", action="append", default=[],
                    help="KS name to skip (repeatable).")
    ap.add_argument("--max-assets-per-ks", type=int, default=0,
                    help="If >0, stop after this many assets per KS (smoke test).")
    args = ap.parse_args()

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
    if not shutil.which("ffmpeg"):
        print("ERROR: ffmpeg not on PATH (brew install ffmpeg)", file=sys.stderr)
        return 1

    s3 = boto3.client("s3", region_name=region)
    s3v = boto3.client("s3vectors", region_name=region)
    br = boto3.client("bedrock-runtime", region_name=region)
    bucket_owner = boto3.client("sts", region_name=region).get_caller_identity()["Account"]
    tl = httpx.Client(timeout=180, headers={"x-api-key": api_key})

    kses = _list_kses(tl)
    print(f"==> {len(kses)} knowledge stores total")
    for ks in kses:
        name = ks["name"]
        if name in args.skip_ks:
            print(f"    [skip] {name!r}")
            continue
        n = ks.get("item_count", 0)
        print(f"\n==> ingesting KS {name!r}  ({ks['_id']}, {n} items)")
        _ingest_ks(
            tl, s3, s3v, br,
            ks_id=ks["_id"],
            clips_bucket=clips_bucket,
            vector_bucket=vector_bucket,
            vector_index=vector_index,
            bucket_owner=bucket_owner,
            max_assets=args.max_assets_per_ks,
        )

    print("\nDone.")
    return 0


def _list_kses(tl: httpx.Client) -> list[dict]:
    r = tl.get(f"{TL_BASE}/knowledge-stores", params={"page_limit": 50})
    r.raise_for_status()
    return r.json().get("data", [])


def _list_ks_assets(tl: httpx.Client, ks_id: str):
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


def _ingest_ks(tl, s3, s3v, br, *, ks_id, clips_bucket, vector_bucket, vector_index,
               bucket_owner, max_assets):
    asset_ids = list(_list_ks_assets(tl, ks_id))
    if max_assets > 0:
        asset_ids = asset_ids[:max_assets]
    if not asset_ids:
        print("    (empty)")
        return

    all_vectors: list[dict] = []
    failures = 0
    completed = 0

    def work(aid: str) -> list[dict]:
        return _ingest_one(tl, s3, br, clips_bucket, aid, ks_id, bucket_owner)

    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        futures = {ex.submit(work, a): a for a in asset_ids}
        for f in as_completed(futures):
            aid = futures[f]
            completed += 1
            try:
                vecs = f.result()
                all_vectors.extend(vecs)
                print(f"    [{completed}/{len(asset_ids)}] {aid}: {len(vecs)} clip vectors")
            except Exception as e:
                failures += 1
                print(f"    [{completed}/{len(asset_ids)}] {aid}: FAILED ({e})", file=sys.stderr)

            # Flush vectors in batches to bound memory + checkpoint progress.
            while len(all_vectors) >= PUT_BATCH:
                batch = all_vectors[:PUT_BATCH]
                s3v.put_vectors(vectorBucketName=vector_bucket, indexName=vector_index, vectors=batch)
                all_vectors = all_vectors[PUT_BATCH:]
                print(f"    [checkpoint] PutVectors {PUT_BATCH}")

    if all_vectors:
        s3v.put_vectors(vectorBucketName=vector_bucket, indexName=vector_index, vectors=all_vectors)
        print(f"    [final] PutVectors {len(all_vectors)}")
    if failures:
        print(f"    {failures} assets failed", file=sys.stderr)


def _ingest_one(tl, s3, br, clips_bucket, asset_id, ks_id, bucket_owner) -> list[dict]:
    s3_key = f"clips/{asset_id}.mp4"
    s3_uri = f"s3://{clips_bucket}/{s3_key}"
    done_marker_key = f"embeddings/{asset_id}/.done"

    # Resume: if we've already written a done marker, skip everything.
    if _s3_object_exists(s3, clips_bucket, done_marker_key):
        return []

    # Stage 1: mirror clip bytes to S3 if missing.
    if not _s3_object_exists(s3, clips_bucket, s3_key):
        hls_url = _resolve_hls_url(tl, asset_id)
        if not hls_url:
            raise RuntimeError("no hls.manifest_url available")
        _ffmpeg_hls_to_s3(hls_url, s3, clips_bucket, s3_key)

    # Stage 2: Bedrock async embed. Opt into all three modality outputs
    # so the index can answer dialog / sound-event / visual queries
    # (see "A Guidance on Multi-Vector Video Search with TwelveLabs
    # Marengo", §1.1, for the modality split).
    invocation = br.start_async_invoke(
        modelId=MARENGO_MODEL_ID,
        modelInput={
            "inputType": "video",
            "video": {
                "mediaSource": {
                    "s3Location": {"uri": s3_uri, "bucketOwner": bucket_owner}
                },
                "embeddingOption": ["visual", "audio", "transcription"],
            },
        },
        outputDataConfig={
            "s3OutputDataConfig": {"s3Uri": f"s3://{clips_bucket}/embeddings/"}
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

    # Multi-vector indexing: one row per (clip, modality). Marengo emits
    # 3 segments per clip when all modalities are requested (assuming
    # the source has speech + non-speech audio; visual is always
    # present). Each is tagged with embedding_option so vector_search
    # can route queries per modality.
    out: list[dict] = []
    for i, seg in enumerate(data.get("data") or []):
        if seg.get("embeddingScope") != "clip":
            continue
        emb = seg.get("embedding") or []
        if not emb:
            continue
        modality = seg.get("embeddingOption") or "visual"
        if modality not in ("visual", "audio", "transcription"):
            continue
        start = int(seg.get("startSec") or 0)
        end = int(seg.get("endSec") or 0)
        out.append({
            "key": f"{asset_id}:{start}:{end}:{modality}:{i}",
            "data": {"float32": emb},
            "metadata": {
                "asset_id":           asset_id,
                "knowledge_store_id": ks_id,
                "start_sec":          start,
                "end_sec":            end,
                "s3_uri":             s3_uri,
                "embedding_option":   modality,
            },
        })

    # Drop the resume marker. The PutVectors hasn't happened yet at this
    # point (that's the caller's job), but the cost of a duplicate
    # PutVectors on a resume is zero (it's upsert-by-key), whereas the
    # cost of repeating ffmpeg+Marengo is real. So mark done after embed.
    s3.put_object(Bucket=clips_bucket, Key=done_marker_key, Body=b"")
    return out


def _resolve_hls_url(tl: httpx.Client, asset_id: str):
    r = tl.get(f"{TL_BASE}/assets/{asset_id}")
    if r.status_code >= 400:
        return None
    return ((r.json().get("hls") or {}).get("manifest_url"))


def _ffmpeg_hls_to_s3(hls_url: str, s3, bucket: str, key: str) -> None:
    """Concatenate the HLS segments into a single mp4 via stream copy
    (no re-encode), then upload. Stream copy keeps it fast and lossless;
    Bedrock Marengo needs an mp4 container, not a playlist.

    `-map 0` explicitly takes ALL streams from the input. Without it
    ffmpeg's auto-selection sometimes drops the audio when the HLS
    manifest exposes streams the auto-mapper considers ambiguous —
    leaving the resulting mp4 video-only, which silently breaks the
    audio + transcription embeddings on the Marengo side."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    tmp.close()
    try:
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", hls_url,
            "-map", "0",
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc",  # mux fix for HLS audio in mp4 container
            tmp.name,
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=600)
        s3.upload_file(tmp.name, bucket, key, ExtraArgs={"ContentType": "video/mp4"})
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg failed: {e.stderr.decode()[:400]}") from e
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass


def _s3_object_exists(s3, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except s3.exceptions.ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


if __name__ == "__main__":
    sys.exit(main())
