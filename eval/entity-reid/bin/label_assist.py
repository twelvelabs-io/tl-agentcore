#!/usr/bin/env python3
"""Auto-suggest ground-truth labels for the entity-reID eval, using
Rekognition Celebrity Detection as an oracle.

For each asset in --assets-file:
  - Sample 2 mid/late frames from hls/<asset>/<asset>_thumb.NNNN.jpg
  - Call Rekognition RecognizeCelebrities
  - Aggregate {celebrity: {asset_ids, best_frame_for_query_crop}}

Top N celebrities (by # of distinct asset_ids they appear in) become the
candidate queries. For each, crop the face bbox from the best frame as
the query thumbnail. Emit:

  queries/<slug>.jpg              — face crops, one per candidate
  ground_truth.suggested.yaml     — pre-filled queries[] for the user to review
  labeling_sheet.html             — visual review page

The user opens the HTML to spot-check, edits ground_truth.suggested.yaml,
renames to ground_truth.yaml.

NOTE: Using Rekognition as the labeling oracle biases the corpus toward
faces Rekognition recognizes. The eval still compares retrieval quality
across Rekognition / Nova / Titan on those queries — what we lose is
"long-tail entity" coverage. For non-celebrity content (dailies),
hand-label instead.

Usage:
  python bin/label_assist.py \
    --ks ks_demo01-trailers-hollywood \
    --assets-file eval/entity-reid/assets_300.txt \
    --top 20 \
    --out-dir eval/entity-reid
"""

from __future__ import annotations

import argparse
import io
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import boto3
import yaml
from PIL import Image

REGION = os.environ.get("AWS_REGION", "us-east-1")
CLIPS = os.environ.get("CLIPS_BUCKET_NAME", "tl-agentcore-1c323e-clips")
THUMB_FRAMES_TO_SCAN = (10, 20)  # which frame indexes per asset to RecognizeCelebrities on
CROP_PAD = 0.20  # 20% padding around face bbox in the saved query thumbnail


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def thumb_keys_for(s3, asset_id: str) -> list[str]:
    """Return the available <asset>_thumb.NNNNNNN.jpg keys, sorted."""
    prefix = f"hls/{asset_id}/"
    resp = s3.list_objects_v2(Bucket=CLIPS, Prefix=prefix)
    return sorted(
        o["Key"] for o in resp.get("Contents", [])
        if "_thumb." in o["Key"] and o["Key"].lower().endswith((".jpg", ".jpeg", ".png"))
    )


def crop_face(image_bytes: bytes, bbox: dict, pad: float = CROP_PAD) -> bytes:
    """Crop the face from `image_bytes` per the Rekognition bbox.
    Pads by `pad` fraction on each side. Re-encodes JPEG q=85."""
    im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = im.size
    bx = bbox["Left"] * w
    by = bbox["Top"] * h
    bw = bbox["Width"] * w
    bh = bbox["Height"] * h
    px = bw * pad
    py = bh * pad
    box = (max(0, int(bx - px)),
           max(0, int(by - py)),
           min(w, int(bx + bw + px)),
           min(h, int(by + bh + py)))
    crop = im.crop(box)
    buf = io.BytesIO()
    crop.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def render_html(suggestions: list[dict], out_dir: Path) -> str:
    """A static HTML labeling sheet — visual check only; the user
    edits the YAML directly."""
    rows = []
    for s in suggestions:
        qid = s["id"]
        rel_img = f"queries/{Path(s['query_image']).name}"
        contains_lines = "\n".join(f"  <li>{a}</li>" for a in s["contains"])
        rows.append(f"""
        <div class="row">
          <img src="{rel_img}" alt="{qid}" />
          <div class="meta">
            <h3>{s['label']}</h3>
            <div class="qid">id: <code>{qid}</code></div>
            <details>
              <summary>{len(s['contains'])} suggested asset matches</summary>
              <ul>{contains_lines}</ul>
            </details>
          </div>
        </div>""")
    return f"""<!doctype html><meta charset="utf-8">
<title>entity-reID labeling sheet</title>
<style>
  body {{ font-family: -apple-system, sans-serif; max-width: 1100px; margin: 24px auto; }}
  .row {{ display: flex; gap: 20px; padding: 12px; border-bottom: 1px solid #eee; }}
  .row img {{ width: 140px; height: 140px; object-fit: cover; border-radius: 6px; background: #f7f7f7; }}
  .meta h3 {{ margin: 0 0 4px 0; }}
  .qid {{ color: #888; font-size: 12px; margin-bottom: 8px; }}
  details ul {{ font-family: ui-monospace, monospace; font-size: 12px; color: #555; }}
  summary {{ cursor: pointer; user-select: none; }}
  h1 {{ font-size: 20px; }}
  p.caveat {{ background: #fff8c5; padding: 10px 14px; border-left: 4px solid #c0a800; font-size: 13px; }}
</style>
<h1>entity-reID labeling sheet</h1>
<p class="caveat">Suggested by Rekognition Celebrity Detection. Spot-check the face thumb + the asset list
for each row, then edit <code>ground_truth.suggested.yaml</code> directly: remove rows where the suggested
identity is wrong, prune/extend the <code>contains:</code> list where the auto-label missed or over-fired.
Save as <code>ground_truth.yaml</code> when done.</p>
{"".join(rows)}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ks", required=True)
    ap.add_argument("--assets-file", type=Path, required=True)
    ap.add_argument("--top", type=int, default=20, help="how many top celebrities to keep as queries")
    ap.add_argument("--min-confidence", type=float, default=85.0)
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()

    asset_ids = [ln.strip() for ln in args.assets_file.read_text().splitlines() if ln.strip()]
    print(f"▌ scanning {len(asset_ids)} assets × {len(THUMB_FRAMES_TO_SCAN)} frames")

    s3 = boto3.client("s3", region_name=REGION)
    rek = boto3.client("rekognition", region_name=REGION)

    # celeb_name -> {"asset_ids": set, "best": (asset_id, key, confidence, bbox)}
    celebs: dict[str, dict] = defaultdict(lambda: {"asset_ids": set(), "best": None})
    n_calls = 0

    for i, aid in enumerate(asset_ids, start=1):
        keys = thumb_keys_for(s3, aid)
        if not keys:
            continue
        # Map THUMB_FRAMES_TO_SCAN to actual indexes that exist.
        idxs = [min(f, len(keys) - 1) for f in THUMB_FRAMES_TO_SCAN]
        for idx in idxs:
            key = keys[idx]
            try:
                resp = rek.recognize_celebrities(Image={"S3Object": {"Bucket": CLIPS, "Name": key}})
                n_calls += 1
            except Exception as e:
                print(f"  ! {aid[:8]} {idx}: {e}")
                continue
            for c in resp.get("CelebrityFaces", []):
                if c.get("MatchConfidence", 0) < args.min_confidence:
                    continue
                name = c["Name"]
                celebs[name]["asset_ids"].add(aid)
                bbox = c["Face"]["BoundingBox"]
                conf = c["MatchConfidence"]
                if celebs[name]["best"] is None or conf > celebs[name]["best"][2]:
                    celebs[name]["best"] = (aid, key, conf, bbox)
        if i % 25 == 0:
            print(f"  · {i}/{len(asset_ids)} scanned, {len(celebs)} unique celebs so far ({n_calls} RecognizeCelebrities calls)")

    ranked = sorted(celebs.items(), key=lambda kv: len(kv[1]["asset_ids"]), reverse=True)
    keep = [(n, info) for n, info in ranked if len(info["asset_ids"]) >= 2][:args.top]
    print(f"\n▌ kept top {len(keep)} celebs (each in ≥2 distinct assets)")

    queries_dir = args.out_dir / "queries"
    queries_dir.mkdir(parents=True, exist_ok=True)
    # wipe smoke-test queries from a prior run (keeps .gitkeep)
    for p in queries_dir.glob("*.jpg"):
        p.unlink()

    suggestions = []
    for name, info in keep:
        slug = slugify(name)
        aid, key, conf, bbox = info["best"]
        try:
            img = s3.get_object(Bucket=CLIPS, Key=key)["Body"].read()
            crop = crop_face(img, bbox)
        except Exception as e:
            print(f"  ! crop {name}: {e}")
            continue
        outp = queries_dir / f"{slug}.jpg"
        outp.write_bytes(crop)
        suggestions.append({
            "id": f"q_{slug}",
            "label": f"{name} — Rekognition Celebrity Detection (conf {conf:.1f}, source asset {aid[:8]})",
            "query_image": f"queries/{slug}.jpg",
            "contains": sorted(info["asset_ids"]),
        })
        print(f"  ✓ {name:30s}  in {len(info['asset_ids']):3d} assets  → {slug}.jpg")

    yaml_path = args.out_dir / "ground_truth.suggested.yaml"
    yaml_path.write_text(yaml.safe_dump(
        {"ks_id": args.ks, "queries": suggestions},
        sort_keys=False, default_flow_style=False,
    ))
    print(f"\n  → {yaml_path}")

    html_path = args.out_dir / "labeling_sheet.html"
    html_path.write_text(render_html(suggestions, args.out_dir))
    print(f"  → {html_path}")
    print(f"\n  ✓ done. {n_calls} RecognizeCelebrities calls = ${n_calls * 0.001:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
