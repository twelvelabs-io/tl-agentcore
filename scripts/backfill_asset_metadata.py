"""Backfill `size` + `duration` on assets rows whose HLS bundle is already
on disk. The hls_finalize lambda now writes these fields, but assets that
finished transcoding before the lambda gained that logic still have empty
size/duration columns (and the UI shows "—" in the right rail).

This script does the same enrichment the lambda does, in-process:
  - HeadObject clips/<asset_id>.mp4 → size
  - Read hls/<asset_id>/<asset_id>_master.m3u8, sum #EXTINF lines → duration

Idempotent. Skips assets that already have both fields populated.

Usage:
    AWS_PROFILE=TLSolProd python scripts/backfill_asset_metadata.py
"""
from __future__ import annotations

import os
import re
import sys

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE", f"{STACK}-assets")
CLIPS_BUCKET = os.environ.get("CLIPS_BUCKET", f"{STACK}-clips")

ddb = boto3.client("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)

EXTINF = re.compile(r"^#EXTINF:([0-9.]+)", re.M)


def _av_to_py(v):
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "NULL" in v: return None
    return None


def _row(item):
    return {k: _av_to_py(v) for k, v in item.items()}


def head_size(asset_id: str) -> int | None:
    try:
        h = s3.head_object(Bucket=CLIPS_BUCKET, Key=f"clips/{asset_id}.mp4")
        return int(h.get("ContentLength", 0)) or None
    except ClientError:
        return None


def duration_sec(asset_id: str) -> int | None:
    key = f"hls/{asset_id}/{asset_id}_master.m3u8"
    try:
        obj = s3.get_object(Bucket=CLIPS_BUCKET, Key=key)
        txt = obj["Body"].read().decode("utf-8", errors="ignore")
        # If this is a master pointing at a variant playlist, follow once.
        variant = None
        for line in txt.splitlines():
            if line and not line.startswith("#") and line.endswith(".m3u8"):
                variant = line
                break
        if variant:
            child = s3.get_object(Bucket=CLIPS_BUCKET, Key=f"hls/{asset_id}/{variant}")
            txt = child["Body"].read().decode("utf-8", errors="ignore")
        total = sum(float(m.group(1)) for m in EXTINF.finditer(txt))
        return int(round(total)) if total > 0 else None
    except ClientError:
        return None


def main() -> int:
    last = None
    updated = 0
    skipped_have = 0
    skipped_no_hls = 0
    examined = 0
    while True:
        kw = dict(TableName=ASSETS_TABLE)
        if last: kw["ExclusiveStartKey"] = last
        out = ddb.scan(**kw)
        for it in out.get("Items", []):
            r = _row(it)
            aid = r.get("asset_id")
            if not aid: continue
            examined += 1
            need_size = not r.get("size")
            need_dur = not r.get("duration")
            if not need_size and not need_dur:
                skipped_have += 1
                continue
            size = head_size(aid) if need_size else None
            dur = duration_sec(aid) if need_dur else None
            if (need_size and size is None) and (need_dur and dur is None):
                skipped_no_hls += 1
                continue
            set_parts, vals, names = [], {}, {}
            if need_size and size is not None:
                set_parts.append("#sz = :sz"); vals[":sz"] = {"N": str(size)}; names["#sz"] = "size"
            if need_dur and dur is not None:
                set_parts.append("#du = :du"); vals[":du"] = {"N": str(dur)}; names["#du"] = "duration"
            if not set_parts:
                continue
            ddb.update_item(
                TableName=ASSETS_TABLE,
                Key={"asset_id": {"S": aid}},
                UpdateExpression="SET " + ", ".join(set_parts),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=vals,
            )
            updated += 1
            print(f"  + {aid}: size={size}, duration={dur}")
        last = out.get("LastEvaluatedKey")
        if not last: break
    print(
        f"done — examined {examined}, updated {updated}, "
        f"skipped {skipped_have} already-populated / {skipped_no_hls} no-hls"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
