#!/usr/bin/env python3
"""Interactive labeler. Walks the assets in a KS and prompts y/n for
"does this asset contain the target person from <query_image>?".
Writes/updates a YAML ground-truth file as it goes (resumable).

Usage:
  python bin/label.py --ks ks_<id> --query queries/01.jpg --out ground_truth.yaml

Open the SPA's Library tab in a browser side-by-side to view each asset
while labeling — this CLI just orders the questions and persists the
answers."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import boto3
import yaml

REGION = os.environ.get("AWS_REGION", "us-east-1")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE")


def iter_assets(ks_id: str):
    ddb = boto3.client("dynamodb", region_name=REGION)
    paginator = ddb.get_paginator("query")
    for page in paginator.paginate(
        TableName=ASSETS_TABLE,
        IndexName="by-ks",
        KeyConditionExpression="knowledge_store_id = :k",
        ExpressionAttributeValues={":k": {"S": ks_id}},
    ):
        for item in page.get("Items", []):
            yield {
                "asset_id": item["asset_id"]["S"],
                "filename": item.get("filename", {}).get("S", "(no name)"),
            }


def load_gt(path: Path) -> dict:
    if not path.exists():
        return {"queries": []}
    with path.open() as f:
        return yaml.safe_load(f) or {"queries": []}


def save_gt(path: Path, gt: dict) -> None:
    with path.open("w") as f:
        yaml.safe_dump(gt, f, sort_keys=False, default_flow_style=False)


def main() -> int:
    if not ASSETS_TABLE:
        print("error: ASSETS_TABLE env var required (terraform output assets_table)", file=sys.stderr)
        return 2

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ks", required=True, help="knowledge_store_id")
    ap.add_argument("--query", required=True, type=Path, help="path to query thumbnail")
    ap.add_argument("--query-id", help="short id for the query (default: filename stem)")
    ap.add_argument("--label", default="", help="human-readable description of the query")
    ap.add_argument("--out", required=True, type=Path, help="ground_truth.yaml to update")
    args = ap.parse_args()

    if not args.query.exists():
        print(f"error: query image not found: {args.query}", file=sys.stderr)
        return 2

    qid = args.query_id or args.query.stem
    gt = load_gt(args.out)
    gt.setdefault("ks_id", args.ks)
    if gt["ks_id"] != args.ks:
        print(f"error: ground_truth.yaml is for ks={gt['ks_id']}, you passed {args.ks}", file=sys.stderr)
        return 2

    queries = gt.setdefault("queries", [])
    existing = next((q for q in queries if q["id"] == qid), None)
    if existing is None:
        existing = {
            "id": qid,
            "label": args.label,
            "query_image": str(args.query.relative_to(args.out.parent) if args.out.parent in args.query.parents else args.query),
            "contains": [],
        }
        queries.append(existing)
    seen = set(existing["contains"])

    assets = list(iter_assets(args.ks))
    print(f"\nlabeling query {qid!r} against {len(assets)} assets in {args.ks}")
    print(f"  hint: open the SPA Library tab to view each asset\n")
    print(f"  keys:  y = contains target   n = does not   s = skip / unknown   q = quit & save\n")

    for i, asset in enumerate(assets, start=1):
        if asset["asset_id"] in seen:
            continue  # already marked positive in a previous session
        prompt = f"[{i}/{len(assets)}] {asset['asset_id']}  {asset['filename'][:50]:50s}  [y/n/s/q] "
        try:
            ans = input(prompt).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\ninterrupted — saving partial progress")
            break
        if ans == "q":
            break
        if ans == "y":
            existing["contains"].append(asset["asset_id"])
            seen.add(asset["asset_id"])
            save_gt(args.out, gt)
        elif ans == "s":
            continue
        # 'n' and anything else = not relevant (no write)

    save_gt(args.out, gt)
    print(f"\n✓ saved {len(existing['contains'])} positive labels for {qid} → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
