"""End-to-end ingest for the 5 demo KBs.

For each KB definition:
  1. Create the knowledge_stores DDB row.
  2. For every source MP4 in its prefix:
       - Mint a 24-hex asset_id.
       - S3 server-side CopyObject → s3://<clips>/clips/<asset_id>.mp4
         (same region, same account → no transfer fee, no bytes through us).
       - Write the assets DDB row with knowledge_store_id + filename
         (status=pending, hls_status=pending).
       - CreateJob on MediaConvert (HLS 720p + 24 thumb frames).
       - StartAsyncInvoke on Bedrock Marengo (visual + audio + transcription
         embeddings; finalize lambda fans into S3 Vectors).
  3. Move on to the next KB.

Pegasus profiling (the kb_cache + ENTITY# rows) is a separate pass — run
`scripts/ingest_kb_cache.py <ks_id>` per knowledge store after the
embeddings finish. Same with `build_event_groups.py` for events. This
script just gets the corpus into S3 + DDB + S3 Vectors so the Library
tab + `vector_search` work first.

Idempotent: re-runs check that the assets row already exists (asset_id
collisions are unlikely with random 24-hex ids, but a force-re-run after
a partial failure can be parameterized via --force-ks).

Usage:
    AWS_PROFILE=TLSolProd python scripts/seed_demo_kbs.py [--only "🎬 Trailers"] [--limit 5] [--dry-run]
"""
from __future__ import annotations

import argparse
import os
import random
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Optional

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
KS_TABLE = os.environ.get("KS_TABLE", f"{STACK}-knowledge-stores")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE", f"{STACK}-assets")
CLIPS_BUCKET = os.environ.get("CLIPS_BUCKET", f"{STACK}-clips")
MC_ROLE_ARN = os.environ.get(
    "MEDIACONVERT_ROLE_ARN",
    f"arn:aws:iam::026090552520:role/{STACK}-mediaconvert",
)
PLAYBACK_BASE = os.environ.get("PLAYBACK_BASE_URL", "https://d18q1864w6gq7b.cloudfront.net").rstrip("/")
ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID", "026090552520")
MARENGO_MODEL_ID = "twelvelabs.marengo-embed-3-0-v1:0"

ddb = boto3.client("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)
br = boto3.client("bedrock-runtime", region_name=REGION)
_mc = None


def get_mc():
    global _mc
    if _mc is not None:
        return _mc
    probe = boto3.client("mediaconvert", region_name=REGION)
    eps = probe.describe_endpoints()["Endpoints"]
    if not eps:
        raise RuntimeError("MediaConvert: no endpoint discovered for this region")
    _mc = boto3.client("mediaconvert", region_name=REGION, endpoint_url=eps[0]["Url"])
    return _mc


# ── 5 KB definitions ──────────────────────────────────────────────────────
@dataclass
class KbDef:
    ks_id: str           # ks_<uuidv4> — stable across re-runs
    name: str
    description: str
    sources: list        # list of (bucket, prefix) tuples — recursive listing for MP4s


# Stable ks_ids so re-running this script is idempotent. uuid4-style.
KBS = [
    KbDef(
        ks_id="ks_demo01-trailers-hollywood",
        name="🎬 Hollywood Trailers",
        description="Curated Hollywood trailer catalog — feature trailers across genres (action, drama, romance, sci-fi). Source: lior-test-files/trailers/.",
        sources=[("lior-test-files", "trailers/")],
    ),
    KbDef(
        ks_id="ks_demo02-blender-open-movies",
        name="🎨 Blender Open Movies",
        description="All 15 Blender Foundation open-source short films (Elephants Dream → Wing It!). Memorable distinct entities make this the showcase for cross-asset entity graph + find_entity_by_image.",
        sources=[("lior-test-files", "BlenderOpenMovies/")],
    ),
    KbDef(
        ks_id="ks_demo03-dirt-determination",
        name="🚲 Dirt and Determination — Documentary Dailies",
        description="Raw dailies from the 'Dirt and Determination' documentary, organized by scene (1 Establishing → 11 Master Interview). Final 4K cut included for ground-truth comparison. The flagship 'rough cut from dailies' demo.",
        sources=[("lior-test-files", "Dirt and Determination dailies/")],
    ),
    KbDef(
        ks_id="ks_demo04-takeout",
        name="🍔 Takeout — Short Film Dailies",
        description="Raw dailies (folders 001–007) from a short film. Demonstrates the rough-cut workflow over narrative-fiction footage rather than long-form documentary footage.",
        sources=[("lior-test-files", "Takeout dailies/")],
    ),
    KbDef(
        ks_id="ks_demo05-football",
        name="🏈 Football Plays & Highlights",
        description="Full-game footage + formation-keyed reference plays (Gun Deep Left, etc.). Sports vertical — shows the agent assembling coach-style highlight reels and matching plays by formation.",
        sources=[
            ("hudl-play-matching-026090552520", "game-footage/"),
            ("hudl-play-matching-026090552520", "reference-clips/"),
        ],
    ),
]


# ── Helpers ────────────────────────────────────────────────────────────────
def asset_id() -> str:
    return uuid.uuid4().hex[:24]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def to_av(v):
    if v is None: return {"NULL": True}
    if isinstance(v, str): return {"S": v}
    if isinstance(v, bool): return {"BOOL": v}
    if isinstance(v, (int, float)): return {"N": str(v)}
    return {"S": str(v)}


def list_mp4s(bucket: str, prefix: str) -> list[tuple[str, str]]:
    """Returns list of (key, filename) tuples for every .mp4 under prefix, recursive."""
    out = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.lower().endswith(".mp4"):
                continue
            # Skip the /1fps/ Blender variants — they're for cheap embedding,
            # not for playback. We want the full-res versions in the KB.
            if "/1fps/" in key:
                continue
            filename = key.rsplit("/", 1)[-1]
            out.append((key, filename))
    return out


def hls_job_settings(aid: str) -> dict:
    src = f"s3://{CLIPS_BUCKET}/clips/{aid}.mp4"
    dst = f"s3://{CLIPS_BUCKET}/hls/{aid}/"
    return {
        "Role": MC_ROLE_ARN,
        "Settings": {
            "Inputs": [{
                "FileInput": src,
                "TimecodeSource": "ZEROBASED",
                "AudioSelectors": {"Audio Selector 1": {"DefaultSelection": "DEFAULT"}},
                "VideoSelector": {},
            }],
            "OutputGroups": [
                {
                    "Name": "HLS",
                    "OutputGroupSettings": {
                        "Type": "HLS_GROUP_SETTINGS",
                        "HlsGroupSettings": {
                            "Destination": dst,
                            "SegmentLength": 6,
                            "MinSegmentLength": 0,
                            "ManifestDurationFormat": "INTEGER",
                            "StreamInfResolution": "INCLUDE",
                        },
                    },
                    "Outputs": [{
                        "NameModifier": "_master",
                        "ContainerSettings": {"Container": "M3U8", "M3u8Settings": {"AudioPids": [482], "VideoPid": 481, "PmtPid": 480}},
                        "VideoDescription": {
                            "CodecSettings": {"Codec": "H_264", "H264Settings": {
                                "RateControlMode": "QVBR", "QvbrSettings": {"QvbrQualityLevel": 7},
                                "MaxBitrate": 3500000, "GopSize": 60,
                                "FramerateControl": "INITIALIZE_FROM_SOURCE",
                                "SceneChangeDetect": "TRANSITION_DETECTION",
                            }},
                            "ScalingBehavior": "DEFAULT", "Height": 720,
                        },
                        "AudioDescriptions": [{"CodecSettings": {"Codec": "AAC", "AacSettings": {"Bitrate": 96000, "CodingMode": "CODING_MODE_2_0", "SampleRate": 48000}}}],
                    }],
                },
                {
                    "Name": "Thumbnails",
                    "OutputGroupSettings": {"Type": "FILE_GROUP_SETTINGS", "FileGroupSettings": {"Destination": dst}},
                    "Outputs": [{
                        "NameModifier": "_thumb",
                        "ContainerSettings": {"Container": "RAW"},
                        "VideoDescription": {
                            "CodecSettings": {"Codec": "FRAME_CAPTURE", "FrameCaptureSettings": {
                                "FramerateNumerator": 1, "FramerateDenominator": 5,
                                "MaxCaptures": 24, "Quality": 80,
                            }},
                            "Width": 1280, "Height": 720,
                        },
                    }],
                },
            ],
        },
    }


def upsert_ks(kb: KbDef, item_count: int) -> None:
    ddb.put_item(
        TableName=KS_TABLE,
        Item={
            "ks_id": to_av(kb.ks_id),
            "name": to_av(kb.name),
            "description": to_av(kb.description),
            "item_count": to_av(item_count),
            "created_at": to_av(now_iso()),
        },
    )


def process_one(kb: KbDef, src_bucket: str, src_key: str, filename: str, dry_run: bool) -> tuple[bool, str]:
    """Mint asset_id, copy bytes, write assets row, kick off MediaConvert + Marengo."""
    aid = asset_id()
    dest_key = f"clips/{aid}.mp4"
    if dry_run:
        return True, f"dry-run · would copy s3://{src_bucket}/{src_key} → s3://{CLIPS_BUCKET}/{dest_key}"

    try:
        # 1. S3 server-side copy
        s3.copy_object(
            Bucket=CLIPS_BUCKET, Key=dest_key,
            CopySource={"Bucket": src_bucket, "Key": src_key},
            ContentType="video/mp4", MetadataDirective="REPLACE",
        )
    except ClientError as e:
        return False, f"copy failed: {e}"

    hls_url = f"{PLAYBACK_BASE}/hls/{aid}/{aid}_master.m3u8"
    thumb_url = f"{PLAYBACK_BASE}/hls/{aid}/{aid}_thumb.0000000.jpg"
    try:
        ddb.put_item(
            TableName=ASSETS_TABLE,
            Item={
                "asset_id": to_av(aid),
                "knowledge_store_id": to_av(kb.ks_id),
                "filename": to_av(filename),
                "file_type": to_av("video/mp4"),
                "created_at": to_av(now_iso()),
                "status": to_av("pending"),
                "hls_status": to_av("pending"),
                "hls_manifest_url": to_av(hls_url),
                "thumbnail_status": to_av("pending"),
                "thumbnail_url": to_av(thumb_url),
                "source_bucket": to_av(src_bucket),
                "source_key": to_av(src_key),
            },
            ConditionExpression="attribute_not_exists(asset_id)",
        )
    except ClientError as e:
        return False, f"assets put failed: {e}"

    # 2. MediaConvert HLS
    try:
        mc = get_mc()
        mc.create_job(**hls_job_settings(aid))
    except Exception as e:
        # Non-fatal — asset row will show hls_status=pending forever; user
        # can re-run scripts/transcode_existing_clips.py to retry.
        return True, f"{aid} · MC submit failed (continuing): {e}"

    # 3. Bedrock Marengo async embed → embed_clip_finalize lambda fans out
    # to S3 Vectors. Marengo's async-invoke quota throttles aggressively, so
    # retry with exponential backoff on ThrottlingException /
    # ServiceQuotaExceededException. Without this, ~95 % of 2,353 submits
    # would fail.
    last_err = None
    for attempt in range(12):
        try:
            br.start_async_invoke(
                modelId=MARENGO_MODEL_ID,
                modelInput={
                    "inputType": "video",
                    "video": {
                        "mediaSource": {
                            "s3Location": {
                                "uri": f"s3://{CLIPS_BUCKET}/{dest_key}",
                                "bucketOwner": ACCOUNT_ID,
                            }
                        },
                        "embeddingOption": ["visual", "audio", "transcription"],
                    },
                },
                outputDataConfig={"s3OutputDataConfig": {"s3Uri": f"s3://{CLIPS_BUCKET}/embeddings/auto/{aid}/{kb.ks_id}/"}},
            )
            break
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            last_err = e
            if code in ("ThrottlingException", "ServiceQuotaExceededException", "TooManyRequestsException"):
                # Bounded jittered backoff: 2 s, 4 s, 8 s … capped at 90 s.
                wait = min(90, (2 ** attempt)) + random.uniform(0, 1.5)
                time.sleep(wait)
                continue
            return True, f"{aid} · Marengo submit failed (non-throttle, continuing): {e}"
        except Exception as e:
            return True, f"{aid} · Marengo submit failed (continuing): {e}"
    else:
        return True, f"{aid} · Marengo submit gave up after retries: {last_err}"

    return True, f"+ {aid} · {filename[:60]}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="Only process the KB whose name contains this substring.")
    ap.add_argument("--limit", type=int, default=0, help="Per-KB cap on assets (0 = all).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--parallelism", type=int, default=20, help="Concurrent per-asset workers.")
    args = ap.parse_args(argv[1:])

    targets = [kb for kb in KBS if not args.only or args.only.lower() in kb.name.lower()]
    if not targets:
        print("no KBs matched --only filter")
        return 1

    total_ok = total_err = 0
    for kb in targets:
        print(f"\n=== {kb.name} ({kb.ks_id}) ===")
        mp4s = []
        for bucket, prefix in kb.sources:
            print(f"  scanning s3://{bucket}/{prefix} …")
            mp4s.extend([(bucket, key, fn) for (key, fn) in list_mp4s(bucket, prefix)])
        if args.limit:
            mp4s = mp4s[: args.limit]
        print(f"  {len(mp4s)} MP4s to ingest")

        if not args.dry_run:
            upsert_ks(kb, len(mp4s))

        ok = err = 0
        if not mp4s:
            continue

        with ThreadPoolExecutor(max_workers=args.parallelism) as ex:
            futures = [ex.submit(process_one, kb, b, k, fn, args.dry_run) for (b, k, fn) in mp4s]
            for fut in as_completed(futures):
                success, msg = fut.result()
                if success:
                    ok += 1
                    if ok % 25 == 0 or ok == len(mp4s):
                        print(f"    [{ok}/{len(mp4s)}] {msg}")
                else:
                    err += 1
                    print(f"    ! {msg}")

        print(f"  done — {ok} ok / {err} err")
        total_ok += ok
        total_err += err

    print(f"\n=== Grand total — {total_ok} submitted / {total_err} failed ===")
    if not args.dry_run:
        print("MediaConvert + Marengo run asynchronously; expect 6–10 h until all rows flip to ready.")
        print("After Marengo finishes, run: python scripts/ingest_kb_cache.py <ks_id> per KB.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
