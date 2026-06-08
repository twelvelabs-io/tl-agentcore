"""One-shot: kick off MediaConvert HLS transcode for every asset row whose
S3 mp4 already exists but whose hls_status is still "pending".

The AWS-native upload pipeline (embed_clip_start λ) runs MediaConvert
automatically on every fresh upload. For clips that were already in
s3://clips/clips/ before that pipeline existed (migrated rows), the
HLS bundle was never generated — Library tab renders them as
"pending" with no thumbnail.

This script:
  1. Scans the assets table.
  2. For each row where hls_status != "ready" and clips/<asset_id>.mp4
     exists, calls MediaConvert::CreateJob with the same job template
     embed_clip_start uses (one HLS rendition + one thumbnail frame).
  3. Updates the row's hls_manifest_url / thumbnail_url to the correct
     `<asset_id>_master.m3u8` naming.
  4. Walks away — the hls_finalize λ flips status to "ready" when the
     master playlist lands in S3.

Idempotent: re-running skips assets that are already "ready" or that
already have an in-flight MediaConvert job.

Usage:
    AWS_PROFILE=TLSolProd python scripts/transcode_existing_clips.py [--limit N]
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE", f"{STACK}-assets")
CLIPS_BUCKET = os.environ.get("CLIPS_BUCKET", f"{STACK}-clips")
MC_ROLE_ARN = os.environ.get(
    "MEDIACONVERT_ROLE_ARN",
    f"arn:aws:iam::026090552520:role/{STACK}-mediaconvert",
)
PLAYBACK_BASE = os.environ.get("PLAYBACK_BASE_URL", "https://d18q1864w6gq7b.cloudfront.net").rstrip("/")

ddb = boto3.client("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)
_mc: Optional[object] = None


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


def _av_to_py(v):
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "NULL" in v: return None
    return None


def _row(item):
    return {k: _av_to_py(v) for k, v in item.items()}


def hls_job_settings(asset_id: str) -> dict:
    """Mirror of the inline job in embed_clip_start.mjs — one H.264 720p
    HLS rendition plus one representative thumbnail."""
    src = f"s3://{CLIPS_BUCKET}/clips/{asset_id}.mp4"
    dst = f"s3://{CLIPS_BUCKET}/hls/{asset_id}/"
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
                        "ContainerSettings": {
                            "Container": "M3U8",
                            "M3u8Settings": {"AudioPids": [482], "VideoPid": 481, "PmtPid": 480},
                        },
                        "VideoDescription": {
                            "CodecSettings": {
                                "Codec": "H_264",
                                "H264Settings": {
                                    "RateControlMode": "QVBR",
                                    "QvbrSettings": {"QvbrQualityLevel": 7},
                                    "MaxBitrate": 3500000,
                                    "GopSize": 60,
                                    "FramerateControl": "INITIALIZE_FROM_SOURCE",
                                    "SceneChangeDetect": "TRANSITION_DETECTION",
                                },
                            },
                            "ScalingBehavior": "DEFAULT",
                            "Height": 720,
                        },
                        "AudioDescriptions": [{
                            "CodecSettings": {
                                "Codec": "AAC",
                                "AacSettings": {"Bitrate": 96000, "CodingMode": "CODING_MODE_2_0", "SampleRate": 48000},
                            },
                        }],
                    }],
                },
                {
                    "Name": "Thumbnails",
                    "OutputGroupSettings": {
                        "Type": "FILE_GROUP_SETTINGS",
                        "FileGroupSettings": {"Destination": dst},
                    },
                    "Outputs": [{
                        "NameModifier": "_thumb",
                        "ContainerSettings": {"Container": "RAW"},
                        "VideoDescription": {
                            "CodecSettings": {
                                "Codec": "FRAME_CAPTURE",
                                "FrameCaptureSettings": {
                                    # 1 frame every 5 s, up to 180 captures
                                    # (~15 min source coverage). Lets the
                                    # UI map any clip's start_time to a
                                    # real captured frame across the full
                                    # source, not just the first 2 min.
                                    "FramerateNumerator": 1,
                                    "FramerateDenominator": 5,
                                    "MaxCaptures": 180,
                                    "Quality": 80,
                                },
                            },
                            "Width": 1280,
                            "Height": 720,
                        },
                    }],
                },
                # Sibling normalized mp4 at `clips/<aid>_normalized.mp4`.
                # asset_profile falls back to this when Pegasus refuses the
                # source codec.
                {
                    "Name": "NormalizedMP4",
                    "OutputGroupSettings": {
                        "Type": "FILE_GROUP_SETTINGS",
                        "FileGroupSettings": {"Destination": f"s3://{CLIPS_BUCKET}/clips/"},
                    },
                    "Outputs": [{
                        "NameModifier": "_normalized",
                        "ContainerSettings": {"Container": "MP4"},
                        "VideoDescription": {
                            "CodecSettings": {
                                "Codec": "H_264",
                                "H264Settings": {
                                    "RateControlMode": "QVBR",
                                    "QvbrSettings": {"QvbrQualityLevel": 6},
                                    "MaxBitrate": 1500000,
                                    "GopSize": 60,
                                    "CodecProfile": "MAIN",
                                    "CodecLevel": "AUTO",
                                    "FramerateControl": "INITIALIZE_FROM_SOURCE",
                                    "SceneChangeDetect": "TRANSITION_DETECTION",
                                },
                            },
                            "ScalingBehavior": "DEFAULT",
                            "Height": 540,
                        },
                        "AudioDescriptions": [{
                            "CodecSettings": {
                                "Codec": "AAC",
                                "AacSettings": {"Bitrate": 96000, "CodingMode": "CODING_MODE_2_0", "SampleRate": 48000},
                            },
                        }],
                    }],
                },
            ],
        },
    }


def clip_exists(asset_id: str) -> bool:
    try:
        s3.head_object(Bucket=CLIPS_BUCKET, Key=f"clips/{asset_id}.mp4")
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


def already_ready(row: dict) -> bool:
    if (row.get("hls_status") or "").lower() == "ready":
        # Confirm the master playlist exists at the new naming.
        aid = row.get("asset_id")
        if not aid:
            return False
        try:
            s3.head_object(Bucket=CLIPS_BUCKET, Key=f"hls/{aid}/{aid}_master.m3u8")
            return True
        except ClientError:
            return False
    return False


def update_urls(asset_id: str) -> None:
    hls_url = f"{PLAYBACK_BASE}/hls/{asset_id}/{asset_id}_master.m3u8" if PLAYBACK_BASE else None
    thumb_url = f"{PLAYBACK_BASE}/hls/{asset_id}/{asset_id}_thumb.0000000.jpg" if PLAYBACK_BASE else None
    expr_values = {}
    set_parts = []
    if hls_url:
        set_parts.append("hls_manifest_url = :h")
        expr_values[":h"] = {"S": hls_url}
    if thumb_url:
        set_parts.append("thumbnail_url = :t")
        expr_values[":t"] = {"S": thumb_url}
    if not set_parts:
        return
    ddb.update_item(
        TableName=ASSETS_TABLE,
        Key={"asset_id": {"S": asset_id}},
        UpdateExpression="SET " + ", ".join(set_parts),
        ExpressionAttributeValues=expr_values,
    )


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Process at most N assets (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="Report what would happen, but don't call MediaConvert.")
    ap.add_argument("--force", action="store_true", help="Re-transcode even assets whose HLS bundle already exists.")
    args = ap.parse_args(argv[1:])

    print(f"scanning {ASSETS_TABLE} for pending HLS rows …")
    last_key = None
    submitted = 0
    skipped_ready = 0
    skipped_no_clip = 0
    examined = 0
    mc = None

    while True:
        kw = dict(TableName=ASSETS_TABLE)
        if last_key:
            kw["ExclusiveStartKey"] = last_key
        out = ddb.scan(**kw)
        for item in out.get("Items", []):
            r = _row(item)
            aid = r.get("asset_id")
            if not aid:
                continue
            examined += 1
            if not args.force and already_ready(r):
                skipped_ready += 1
                continue
            if not clip_exists(aid):
                skipped_no_clip += 1
                continue
            update_urls(aid)
            if args.dry_run:
                print(f"  · {aid}: would transcode")
            else:
                if mc is None:
                    mc = get_mc()
                try:
                    job = mc.create_job(**hls_job_settings(aid))
                    print(f"  + {aid}: MC job {job['Job']['Id']}")
                except Exception as e:
                    print(f"  ! {aid}: MC CreateJob failed — {e}")
                    continue
            submitted += 1
            if args.limit and submitted >= args.limit:
                last_key = None
                break
        last_key = out.get("LastEvaluatedKey")
        if not last_key:
            break

    print(
        f"done — examined {examined}, "
        f"{'planned' if args.dry_run else 'submitted'} {submitted}, "
        f"skipped {skipped_ready} ready / {skipped_no_clip} no-clip"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
