"""Migrate kb_cache → AWS-native knowledge_stores + assets tables.

The old demo deployment held the canonical KS / asset registry in
TwelveLabs SaaS and used kb_cache (DynamoDB) only for derived profile
rows. The new AWS-only deployment owns the registry entirely — every
operator's KS list comes from `knowledge_stores`, every asset row from
`assets`.

This script bootstraps both tables for an existing kb_cache so the demo
keeps working after the cutover. For each `ks#<ks_id>` partition it
sees in kb_cache, it:

  1. Creates a knowledge_stores row if one doesn't already exist.
     name + description default to the OVERVIEW row's `title` + the
     `top_moods` summary; operators rename via the UI later.
  2. For every `ASSET#<asset_id>` row, creates an assets row pointing
     at clips/<asset_id>.mp4 in the clips bucket. Stamps the HLS URL
     to the CloudFront /hls/ path so the player can attempt playback
     once MediaConvert has been run against each asset.

Idempotent — re-running it does not duplicate rows (`ConditionExpression`
on the PutItem). The script does NOT run MediaConvert; HLS bundles for
pre-existing clips need to be transcoded out of band (see
`scripts/transcode_existing_clips.py` or the upload+embed lambda's
auto-flow on a fresh upload).

Usage:
    AWS_PROFILE=TLSolProd python scripts/migrate_to_aws_native.py [ks_id ...]

With no args, walks every ks#... partition in kb_cache. Passing one or
more ks_ids limits the migration to those.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Iterable

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
KB_CACHE_TABLE = os.environ.get("KB_CACHE_TABLE", f"{STACK}-kb-cache")
KS_TABLE = os.environ.get("KS_TABLE", f"{STACK}-knowledge-stores")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE", f"{STACK}-assets")
PLAYBACK_BASE = os.environ.get("PLAYBACK_BASE_URL", "").rstrip("/")

ddb = boto3.client("dynamodb", region_name=REGION)


def _av_to_py(v):
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "L" in v: return [_av_to_py(x) for x in v["L"]]
    if "M" in v: return {k: _av_to_py(x) for k, x in v["M"].items()}
    if "SS" in v: return list(v["SS"])
    if "NULL" in v: return None
    return None


def _row(item):
    return {k: _av_to_py(v) for k, v in item.items()}


def _av(v):
    if v is None: return {"NULL": True}
    if isinstance(v, str): return {"S": v}
    if isinstance(v, bool): return {"BOOL": v}
    if isinstance(v, (int, float)): return {"N": str(v)}
    if isinstance(v, list): return {"L": [_av(x) for x in v]}
    if isinstance(v, dict): return {"M": {k: _av(x) for k, x in v.items()}}
    return {"S": str(v)}


def _discover_ks_ids() -> set[str]:
    """Scan kb_cache for every ks#... partition."""
    ks_ids: set[str] = set()
    last = None
    while True:
        kw = dict(TableName=KB_CACHE_TABLE, ProjectionExpression="pk")
        if last:
            kw["ExclusiveStartKey"] = last
        out = ddb.scan(**kw)
        for it in out.get("Items", []):
            pk = it.get("pk", {}).get("S", "")
            if pk.startswith("ks#"):
                ks_ids.add(pk[3:])
        last = out.get("LastEvaluatedKey")
        if not last:
            break
    return ks_ids


def _query_partition(pk: str) -> list[dict]:
    rows: list[dict] = []
    last = None
    while True:
        kw = dict(
            TableName=KB_CACHE_TABLE,
            KeyConditionExpression="pk = :p",
            ExpressionAttributeValues={":p": {"S": pk}},
        )
        if last:
            kw["ExclusiveStartKey"] = last
        out = ddb.query(**kw)
        rows.extend(_row(it) for it in out.get("Items", []))
        last = out.get("LastEvaluatedKey")
        if not last:
            break
    return rows


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def _migrate_one(ks_id: str) -> tuple[int, int]:
    """Returns (ks_inserted_count, assets_inserted_count). 0/0 means a
    no-op (rows already existed); existing rows are not overwritten."""
    rows = _query_partition(f"ks#{ks_id}")
    overview = next((r for r in rows if r.get("sk") == "OVERVIEW"), {})
    asset_rows = [r for r in rows if str(r.get("sk", "")).startswith("ASSET#")]

    # KS row
    ks_name = overview.get("title") or f"Knowledge store {ks_id[-6:]}"
    moods = overview.get("top_moods") or []
    description = (
        f"{len(asset_rows)} assets · moods: {', '.join(moods[:5])}"
        if asset_rows
        else "Imported from kb_cache."
    )
    ks_inserted = 0
    try:
        ddb.put_item(
            TableName=KS_TABLE,
            Item={
                "ks_id":       _av(ks_id),
                "name":        _av(ks_name),
                "description": _av(description),
                "item_count":  _av(len(asset_rows)),
                "created_at":  _av(_now_iso()),
            },
            ConditionExpression="attribute_not_exists(ks_id)",
        )
        ks_inserted = 1
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise

    # Asset rows
    assets_inserted = 0
    for r in asset_rows:
        aid = r.get("asset_id") or str(r.get("sk", "")).split("#", 1)[-1]
        if not aid:
            continue
        hls_url = f"{PLAYBACK_BASE}/hls/{aid}/{aid}_master.m3u8" if PLAYBACK_BASE else None
        thumb_url = f"{PLAYBACK_BASE}/hls/{aid}/{aid}_thumb.0000000.jpg" if PLAYBACK_BASE else None
        try:
            ddb.put_item(
                TableName=ASSETS_TABLE,
                Item={
                    "asset_id":           _av(aid),
                    "knowledge_store_id": _av(ks_id),
                    "filename":           _av(r.get("title") or f"{aid}.mp4"),
                    "file_type":          _av("video/mp4"),
                    "created_at":         _av(_now_iso()),
                    # Migrated rows are pending HLS — operator runs MediaConvert
                    # against existing clips out-of-band, or re-uploads via UI.
                    "status":             _av("pending"),
                    "hls_status":         _av("pending"),
                    "hls_manifest_url":   _av(hls_url) if hls_url else {"NULL": True},
                    "thumbnail_status":   _av("pending"),
                    "thumbnail_url":      _av(thumb_url) if thumb_url else {"NULL": True},
                },
                ConditionExpression="attribute_not_exists(asset_id)",
            )
            assets_inserted += 1
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
    return ks_inserted, assets_inserted


def main(argv: list[str]) -> int:
    targets: Iterable[str]
    if len(argv) > 1:
        targets = argv[1:]
    else:
        print(f"scanning {KB_CACHE_TABLE} for ks#... partitions …")
        ks_ids = _discover_ks_ids()
        print(f"  found {len(ks_ids)} knowledge stores")
        targets = sorted(ks_ids)

    if not targets:
        print("no targets — nothing to migrate")
        return 0

    total_ks, total_assets = 0, 0
    for ks_id in targets:
        ks_inserted, assets_inserted = _migrate_one(ks_id)
        total_ks += ks_inserted
        total_assets += assets_inserted
        marker = "+" if ks_inserted else "·"
        print(f"  {marker} {ks_id}: ks{'+1' if ks_inserted else ' (existing)'}  assets+{assets_inserted}")
    print(f"done — knowledge_stores +{total_ks}  assets +{total_assets}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
