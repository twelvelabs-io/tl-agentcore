"""Pre-build the Tier-1 cache for a TwelveLabs knowledge store.

Reads every asset in the KB, runs a structured Pegasus analysis against
each, and writes the result to the profile_cache DynamoDB table — one row per
asset (sk = ASSET#<asset_id>) plus a corpus overview row (sk = OVERVIEW).

Usage:
    export TL_API_KEY=tlk_...
    export PROFILE_CACHE_TABLE=tl-agentcore-...-profile-cache    # from terraform output
    export AWS_REGION=us-east-1
    python scripts/ingest_profile_cache.py ks_<id>

Throughput: ~150 assets/min (12-way Pegasus concurrency, default in this
script). A 1,300-clip KB takes ~15 minutes.

NOTE: this is a SKELETON — the production version of this script (in the
internal Jocky lab) computes a richer per-asset profile schema (mood_tags,
visual_style, role_hint, primary_subjects). Port that here when finalizing
the whitepaper companion.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python ingest_profile_cache.py <knowledge_store_id>")
        return 2

    ks_id = sys.argv[1]
    api_key = os.environ.get("TL_API_KEY")
    table = os.environ.get("PROFILE_CACHE_TABLE")
    if not api_key:
        print("ERROR: TL_API_KEY env var required")
        return 1
    if not table:
        print("ERROR: PROFILE_CACHE_TABLE env var required (terraform output profile_cache_table)")
        return 1

    print(f"Stub — would ingest {ks_id} into {table}.")
    print("TODO: port from the internal Jocky lab. Schema:")
    print("  pk = ks#<knowledge_store_id>")
    print("  sk = OVERVIEW                → corpus digest")
    print("  sk = ASSET#<asset_id>        → per-asset profile")
    print("  Profile fields: title, one_liner, mood_tags[], primary_subjects[],")
    print("                  visual_style, role_hint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
