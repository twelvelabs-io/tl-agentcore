#!/usr/bin/env python3
"""Seed the rights DDB table with demo licensing records.

Idempotent — overwrites existing records. Run once after `terraform apply`
to make the agent's lookup_rights tool return useful data in demos.

Usage:
  export RIGHTS_TABLE=$(terraform -chdir=infra output -raw rights_table)
  python3 scripts/seed_rights.py [--ks-id ks_<id> --pick 10]

Default behavior: seed a small set of synthetic records keyed by placeholder
asset_ids — overridden by --ks-id to seed real asset_ids pulled from a KS.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any

import boto3
import httpx

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE  = os.environ.get("RIGHTS_TABLE")
TL_BASE = os.environ.get("TL_BASE_URL", "https://api.twelvelabs.io/v1.3")
TL_KEY  = os.environ.get("TL_API_KEY")

if not TABLE:
    print("error: RIGHTS_TABLE env var required", file=sys.stderr)
    sys.exit(2)

ddb = boto3.client("dynamodb", region_name=REGION)


SAMPLE_RIGHTS = [
    {
        "title": "Highlight Reel A",
        "rights": [
            {"region": "GLOBAL", "window_start": "2026-01-01", "window_end": "2027-12-31",
             "usage": ["broadcast", "social", "internal"]},
        ],
        "talent_clearances": [
            {"name": "Anchor Talent", "status": "cleared", "scope": "all-uses"},
        ],
    },
    {
        "title": "Highlight Reel B",
        "rights": [
            {"region": "US", "window_start": "2026-03-01", "window_end": "2026-09-30",
             "usage": ["broadcast"]},
            {"region": "EMEA", "window_start": "2026-03-01", "window_end": "2026-06-30",
             "usage": ["social"]},
        ],
        "talent_clearances": [],
    },
    {
        "title": "Archive Footage",
        "rights": [
            {"region": "GLOBAL", "window_start": "2020-01-01", "window_end": "2025-12-31",
             "usage": ["internal"]},
        ],
        "talent_clearances": [
            {"name": "Pundit", "status": "expired", "expired_at": "2024-12-31"},
        ],
    },
]


def _to_ddb(value: Any) -> dict[str, Any]:
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        return {"L": [_to_ddb(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: _to_ddb(v) for k, v in value.items()}}
    return {"S": str(value)}


def fetch_ks_asset_ids(ks_id: str, pick: int) -> list[str]:
    if not TL_KEY:
        print("error: TL_API_KEY required when --ks-id is set", file=sys.stderr)
        sys.exit(2)
    out: list[str] = []
    with httpx.Client(timeout=60) as c:
        r = c.get(
            f"{TL_BASE}/knowledge-stores/{ks_id}/items",
            headers={"x-api-key": TL_KEY},
            params={"page_limit": min(pick, 50)},
        )
    r.raise_for_status()
    for it in (r.json().get("data") or [])[:pick]:
        aid = it.get("asset_id")
        if aid:
            out.append(aid)
    return out


def put(asset_id: str, payload: dict[str, Any]) -> None:
    item = {
        "asset_id":    {"S": asset_id},
        "title":       _to_ddb(payload["title"]),
        "rights":      _to_ddb(payload["rights"]),
        "talent_clearances": _to_ddb(payload["talent_clearances"]),
        "seeded_at":   {"N": str(int(time.time()))},
    }
    ddb.put_item(TableName=TABLE, Item=item)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ks-id", help="If set, fetches real asset_ids from this KS and seeds them instead of synthetic ids.")
    ap.add_argument("--pick", type=int, default=10, help="How many asset_ids to pull from --ks-id.")
    args = ap.parse_args()

    if args.ks_id:
        ids = fetch_ks_asset_ids(args.ks_id, args.pick)
        print(f"→ seeding {len(ids)} real asset_ids from {args.ks_id}")
    else:
        ids = [f"demo-asset-{i:03d}" for i in range(1, 11)]
        print(f"→ seeding {len(ids)} synthetic asset_ids")

    for i, aid in enumerate(ids):
        payload = SAMPLE_RIGHTS[i % len(SAMPLE_RIGHTS)]
        put(aid, payload)
        print(f"  ✓ {aid[:24]} → {payload['title']}")

    print(f"\n→ done · {len(ids)} rights records in {TABLE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
