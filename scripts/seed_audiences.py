#!/usr/bin/env python3
"""Seed the audiences DDB table with demo audience-intelligence segments.

Idempotent. Run once after `terraform apply` to make the agent's
list_audiences / lookup_audience tools return useful data.

Usage:
  export AUDIENCES_TABLE=$(terraform -chdir=infra output -raw audiences_table)
  python3 scripts/seed_audiences.py
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
TABLE  = os.environ.get("AUDIENCES_TABLE")

if not TABLE:
    print("error: AUDIENCES_TABLE env var required", file=sys.stderr)
    sys.exit(2)

ddb = boto3.client("dynamodb", region_name=REGION)


SEGMENTS = [
    {
        "segment_id": "M_25_54",
        "name": "Men 25-54",
        "description": "Adult men, broad demographic. Heaviest skew toward sports + action.",
        "demographics": {"age": "25-54", "gender": "M"},
        "size_estimate": 48_000_000,
        "genre_affinity": [
            {"genre": "sports",       "index": 1.6},
            {"genre": "action",       "index": 1.4},
            {"genre": "crime-drama",  "index": 1.2},
            {"genre": "comedy",       "index": 1.0},
            {"genre": "reality",      "index": 0.7},
            {"genre": "romance",      "index": 0.5},
        ],
        "daypart_affinity": [
            {"daypart": "primetime",    "index": 1.2},
            {"daypart": "late-night",   "index": 1.4},
            {"daypart": "weekend-day",  "index": 1.6},
            {"daypart": "morning",      "index": 0.6},
        ],
        "notes": "Strong sports affinity peaks during live event windows.",
    },
    {
        "segment_id": "W_25_54",
        "name": "Women 25-54",
        "description": "Adult women, broad demographic.",
        "demographics": {"age": "25-54", "gender": "F"},
        "size_estimate": 51_000_000,
        "genre_affinity": [
            {"genre": "drama",       "index": 1.5},
            {"genre": "reality",     "index": 1.4},
            {"genre": "romance",     "index": 1.3},
            {"genre": "comedy",      "index": 1.1},
            {"genre": "documentary", "index": 1.0},
            {"genre": "sports",      "index": 0.6},
            {"genre": "action",      "index": 0.7},
        ],
        "daypart_affinity": [
            {"daypart": "primetime",    "index": 1.3},
            {"daypart": "morning",      "index": 1.2},
            {"daypart": "daytime",      "index": 1.4},
            {"daypart": "late-night",   "index": 0.7},
        ],
        "notes": "Reality + character-driven drama overindex strongly in primetime.",
    },
    {
        "segment_id": "FAMILY",
        "name": "Families with children under 18",
        "description": "Households with at least one child under 18; viewing is co-viewing.",
        "demographics": {"household": "with-kids-under-18"},
        "size_estimate": 32_000_000,
        "genre_affinity": [
            {"genre": "animation",   "index": 1.8},
            {"genre": "family-film", "index": 1.6},
            {"genre": "comedy",      "index": 1.3},
            {"genre": "sports",      "index": 1.1},
            {"genre": "horror",      "index": 0.3},
            {"genre": "crime-drama", "index": 0.5},
        ],
        "daypart_affinity": [
            {"daypart": "morning",     "index": 1.4},
            {"daypart": "weekend-day", "index": 1.6},
            {"daypart": "primetime",   "index": 1.1},
            {"daypart": "late-night",  "index": 0.4},
        ],
        "notes": "Avoid mature content and intense violence — co-view restriction.",
    },
    {
        "segment_id": "SPORTS_ENTH",
        "name": "Sports enthusiasts",
        "description": "Heavy sports-content consumers across all demographics.",
        "demographics": {"interest": "sports"},
        "size_estimate": 28_000_000,
        "genre_affinity": [
            {"genre": "sports",         "index": 2.4},
            {"genre": "documentary",    "index": 1.3},
            {"genre": "action",         "index": 1.2},
            {"genre": "reality",        "index": 0.9},
            {"genre": "drama",          "index": 0.8},
        ],
        "daypart_affinity": [
            {"daypart": "primetime",   "index": 1.3},
            {"daypart": "weekend-day", "index": 1.8},
            {"daypart": "late-night",  "index": 1.2},
            {"daypart": "morning",     "index": 0.9},
        ],
        "notes": "Highest engagement during live event windows; sports-doc content travels well in off-season.",
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


def main() -> int:
    for seg in SEGMENTS:
        item: dict[str, Any] = {
            "segment_id": {"S": seg["segment_id"]},
            "seeded_at":  {"N": str(int(time.time()))},
        }
        for k, v in seg.items():
            if k == "segment_id":
                continue
            item[k] = _to_ddb(v)
        ddb.put_item(TableName=TABLE, Item=item)
        print(f"  ✓ {seg['segment_id']:15s} {seg['name']}")

    print(f"\n→ done · {len(SEGMENTS)} audience segments in {TABLE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
