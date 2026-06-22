#!/usr/bin/env python3
"""One-shot Rekognition backfill for existing KSes.

Invokes the production index_faces lambda in batches of <=50 assets per
call (keeps each invocation well under the 15-min Lambda timeout — 4
frames/asset × ~0.5 s/IndexFaces × 50 assets ≈ 100 s). The lambda lazy-
creates the per-KS collection, so this script works on a brand-new
deploy as well as an existing one.

Usage:
  AWS_PROFILE=... python scripts/backfill_rekognition.py --ks ks_<id>
  AWS_PROFILE=... python scripts/backfill_rekognition.py --all
  AWS_PROFILE=... python scripts/backfill_rekognition.py --ks ks_<id> --limit 300  # eval-scoped

Reads the assets table (by-ks GSI) to enumerate asset_ids per KS.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import boto3
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE", f"{STACK}-assets")
KS_TABLE = os.environ.get("KS_TABLE", f"{STACK}-knowledge-stores")
LAMBDA_NAME = os.environ.get("INDEX_FACES_LAMBDA", f"{STACK}-index-faces")
# 25 assets/batch × 4 frames/asset × ~0.5 s/IndexFaces ≈ 50 s per invoke.
# Plus headroom for the occasional slow image. Lambda's own timeout is
# 900 s (set in infra/rekognition.tf); we just need our boto3 client to
# wait long enough for the sync RequestResponse to come back.
BATCH = int(os.environ.get("BATCH_SIZE", "25"))
LAMBDA_READ_TIMEOUT = 300  # seconds


def list_ks_ids() -> list[str]:
    ddb = boto3.client("dynamodb", region_name=REGION)
    out = []
    paginator = ddb.get_paginator("scan")
    for page in paginator.paginate(TableName=KS_TABLE, ProjectionExpression="ks_id"):
        for it in page.get("Items", []):
            ks = it.get("ks_id", {}).get("S")
            if ks:
                out.append(ks)
    return out


def list_assets(ks_id: str, limit: int | None = None) -> list[str]:
    ddb = boto3.client("dynamodb", region_name=REGION)
    out = []
    paginator = ddb.get_paginator("query")
    for page in paginator.paginate(
        TableName=ASSETS_TABLE, IndexName="by-ks",
        KeyConditionExpression="knowledge_store_id = :k",
        ExpressionAttributeValues={":k": {"S": ks_id}},
        ProjectionExpression="asset_id",
    ):
        for it in page.get("Items", []):
            aid = it.get("asset_id", {}).get("S")
            if aid:
                out.append(aid)
                if limit and len(out) >= limit:
                    return out
    return out


def backfill_ks(ks_id: str, limit: int | None = None) -> dict:
    asset_ids = list_assets(ks_id, limit=limit)
    if not asset_ids:
        print(f"  · {ks_id}: no assets")
        return {"ks_id": ks_id, "assets": 0, "faces": 0}
    lam = boto3.client(
        "lambda", region_name=REGION,
        config=Config(read_timeout=LAMBDA_READ_TIMEOUT, retries={"max_attempts": 1}),
    )
    total_faces = 0
    total_failures = []
    for i in range(0, len(asset_ids), BATCH):
        batch = asset_ids[i:i + BATCH]
        t0 = time.time()
        resp = lam.invoke(
            FunctionName=LAMBDA_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps({"ks_id": ks_id, "asset_ids": batch}).encode(),
        )
        payload = json.loads(resp["Payload"].read())
        if resp.get("FunctionError"):
            print(f"  ! {ks_id} batch {i}-{i + len(batch)}: FunctionError={resp['FunctionError']}  {payload}")
            return {"ks_id": ks_id, "error": resp["FunctionError"], "payload": payload}
        total_faces += payload.get("faces_indexed", 0)
        total_failures += payload.get("failures", [])
        elapsed = time.time() - t0
        print(f"  · {ks_id} [{i + len(batch)}/{len(asset_ids)}]  +{payload.get('faces_indexed', 0)} faces  in {elapsed:.1f}s")
    return {
        "ks_id": ks_id,
        "assets": len(asset_ids),
        "faces": total_faces,
        "failures": total_failures,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--ks", help="single knowledge_store_id to backfill")
    g.add_argument("--all", action="store_true", help="backfill every KS in the table")
    ap.add_argument("--limit", type=int, default=None, help="cap assets per KS (for smoke tests)")
    args = ap.parse_args()

    ks_ids = list_ks_ids() if args.all else [args.ks]
    print(f"▌ backfilling {len(ks_ids)} KS(es) via {LAMBDA_NAME}")

    summary = []
    for ks in ks_ids:
        r = backfill_ks(ks, limit=args.limit)
        summary.append(r)

    print("\n=== summary ===")
    total_assets = sum(s.get("assets", 0) for s in summary)
    total_faces = sum(s.get("faces", 0) for s in summary)
    for s in summary:
        if "error" in s:
            print(f"  ✘ {s['ks_id']}  error={s['error']}")
        else:
            print(f"  ✓ {s['ks_id']:40s}  {s['assets']:5d} assets  {s['faces']:6d} faces")
    print(f"\n  total: {total_assets} assets, {total_faces} face vectors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
