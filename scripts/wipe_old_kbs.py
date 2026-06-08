"""Remove the two pre-existing KBs that were migrated from kb_cache:
  - ks_069f98e3-74f8-70a6-8000-a22091ec13b2
  - ks_06a0806c-4ab2-7683-8000-cbab3900ced6

Cleans:
  - The knowledge_stores row
  - Every assets row whose knowledge_store_id matches (via GSI by-ks)
  - Every kb_cache row under pk=ks#<id>
  - The orphaned clips/<asset_id>.mp4 + hls/<asset_id>/ folders in S3

Idempotent. Re-runnable until the rows are gone.

Usage:
    AWS_PROFILE=TLSolProd python scripts/wipe_old_kbs.py
    AWS_PROFILE=TLSolProd python scripts/wipe_old_kbs.py --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Iterable

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
KS_TABLE = f"{STACK}-knowledge-stores"
ASSETS_TABLE = f"{STACK}-assets"
KB_CACHE_TABLE = f"{STACK}-kb-cache"
CLIPS_BUCKET = f"{STACK}-clips"

OLD_KS_IDS = [
    "ks_069f98e3-74f8-70a6-8000-a22091ec13b2",
    "ks_06a0806c-4ab2-7683-8000-cbab3900ced6",
]

ddb = boto3.client("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)


def list_assets_for(ks_id: str) -> list[str]:
    out = []
    last = None
    while True:
        kw = dict(
            TableName=ASSETS_TABLE,
            IndexName="by-ks",
            KeyConditionExpression="knowledge_store_id = :k",
            ExpressionAttributeValues={":k": {"S": ks_id}},
            ProjectionExpression="asset_id",
        )
        if last: kw["ExclusiveStartKey"] = last
        r = ddb.query(**kw)
        for it in r.get("Items", []):
            out.append(it["asset_id"]["S"])
        last = r.get("LastEvaluatedKey")
        if not last:
            break
    return out


def query_kb_cache_keys(ks_id: str) -> Iterable[dict]:
    last = None
    while True:
        kw = dict(
            TableName=KB_CACHE_TABLE,
            KeyConditionExpression="pk = :p",
            ExpressionAttributeValues={":p": {"S": f"ks#{ks_id}"}},
            ProjectionExpression="pk,sk",
        )
        if last: kw["ExclusiveStartKey"] = last
        r = ddb.query(**kw)
        for it in r.get("Items", []):
            yield it
        last = r.get("LastEvaluatedKey")
        if not last:
            break


def delete_s3_prefix(prefix: str) -> int:
    """Delete every object under prefix. Returns count."""
    count = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=CLIPS_BUCKET, Prefix=prefix):
        keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
        if not keys:
            continue
        s3.delete_objects(Bucket=CLIPS_BUCKET, Delete={"Objects": keys})
        count += len(keys)
    return count


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--keep-clips", action="store_true", help="Don't delete S3 clips/<asset_id>.mp4 + hls bundles.")
    args = ap.parse_args(argv[1:])

    for ks_id in OLD_KS_IDS:
        print(f"\n=== {ks_id} ===")
        # 1. Find every asset_id pointing at this KS
        assets = list_assets_for(ks_id)
        print(f"  {len(assets)} assets in by-ks GSI")

        # 2. kb_cache partition size
        cache_keys = list(query_kb_cache_keys(ks_id))
        print(f"  {len(cache_keys)} kb_cache rows under ks#{ks_id}")

        if args.dry_run:
            for aid in assets[:5]:
                print(f"    · would delete asset {aid}")
            continue

        # 3. Delete assets rows
        for aid in assets:
            try:
                ddb.delete_item(TableName=ASSETS_TABLE, Key={"asset_id": {"S": aid}})
            except Exception as e:
                print(f"    ! delete asset {aid} failed: {e}")

        # 4. Delete kb_cache rows
        for it in cache_keys:
            try:
                ddb.delete_item(TableName=KB_CACHE_TABLE, Key={"pk": it["pk"], "sk": it["sk"]})
            except Exception as e:
                print(f"    ! delete cache {it} failed: {e}")

        # 5. Delete KS row itself
        try:
            ddb.delete_item(TableName=KS_TABLE, Key={"ks_id": {"S": ks_id}})
            print(f"  KS row deleted")
        except Exception as e:
            print(f"  ! delete KS {ks_id} failed: {e}")

        # 6. Optionally clean S3 artifacts
        if not args.keep_clips:
            for aid in assets:
                # Source mp4 and HLS bundle. Cheap delete-many.
                try:
                    s3.delete_object(Bucket=CLIPS_BUCKET, Key=f"clips/{aid}.mp4")
                except Exception:
                    pass
                n = delete_s3_prefix(f"hls/{aid}/")
                if n:
                    pass  # quiet — only log if we want noise
            print(f"  cleaned S3 clips/ + hls/ for {len(assets)} assets")

    print("\n=== wipe complete ===")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
