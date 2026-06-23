#!/usr/bin/env python3
"""Run the ingest step for one non-Titan pipeline against a KS.

The current_titan pipeline has no ingest step (it reads the production
entity-patches index). Skip running this for current_titan.

Usage:
  python bin/ingest.py --pipeline rekognition_faces --ks ks_<id>
  python bin/ingest.py --pipeline nova_mm_embed     --ks ks_<id> --max-assets 50
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Add parent so `pipelines` imports as expected when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipelines import get  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pipeline", required=True, choices=("rekognition_faces", "nova_mm_embed"))
    ap.add_argument("--ks", required=True, help="knowledge_store_id")
    ap.add_argument("--max-assets", type=int, default=None,
                    help="cap for smoke-testing on a subset before a full run")
    ap.add_argument("--assets-file", type=Path, default=None,
                    help="text file with one asset_id per line — index exactly these "
                         "(overrides --max-assets). Used to keep the 3 pipelines on "
                         "the same corpus subset.")
    args = ap.parse_args()

    asset_ids = None
    if args.assets_file:
        asset_ids = [ln.strip() for ln in args.assets_file.read_text().splitlines() if ln.strip()]
        print(f"▌ using explicit asset list: {len(asset_ids)} ids from {args.assets_file}")

    p = get(args.pipeline)
    print(f"▌ ingesting {args.ks} via {p.name}")
    if args.max_assets and asset_ids is None:
        print(f"  (capped at {args.max_assets} assets)")
    p.ingest(args.ks, max_assets=args.max_assets, asset_ids=asset_ids)
    return 0


if __name__ == "__main__":
    sys.exit(main())
