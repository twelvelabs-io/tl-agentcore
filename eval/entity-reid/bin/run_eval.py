#!/usr/bin/env python3
"""Run the entity-reID quality eval. Loads ground_truth.yaml, runs every
named pipeline against every query, computes per-query + aggregate
metrics, prints a markdown report.

Usage:
  python bin/run_eval.py --gt ground_truth.yaml \
      --pipelines current_titan,rekognition_faces,nova_mm_embed
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from metrics import score_query, summarize  # noqa: E402
from pipelines import get  # noqa: E402

KS_TOPK = 50  # over-fetch; metrics evaluate at K=1/5/10/20


def run_pipeline(pipeline, queries: list[dict], query_root: Path) -> dict:
    """Returns {query_id: {ranked: [asset_id, ...], metrics: {...}}}."""
    out = {}
    t_total = 0.0
    for q in queries:
        img_path = query_root / q["query_image"]
        img = img_path.read_bytes()
        t0 = time.perf_counter()
        ranked = pipeline.query(img, k=KS_TOPK)
        t = time.perf_counter() - t0
        t_total += t
        asset_ids = [a for a, _ in ranked]
        relevant = set(q.get("contains") or [])
        out[q["id"]] = {
            "ranked": asset_ids,
            "metrics": score_query(asset_ids, relevant),
            "latency_s": t,
        }
    out["_meta"] = {"total_query_time_s": t_total, "queries": len(queries)}
    return out


def fmt(v: float) -> str:
    if v != v:  # NaN
        return "—"
    return f"{v:.3f}"


def render_markdown(gt: dict, per_pipeline: dict[str, dict]) -> str:
    lines = []
    lines.append(f"# entity-reID eval — `{gt['ks_id']}`")
    lines.append("")
    lines.append(f"{len(gt['queries'])} queries, {len(per_pipeline)} pipelines.")
    lines.append("")
    lines.append("## Aggregate")
    lines.append("")
    cols = ["recall@1", "recall@5", "recall@10", "recall@20",
            "precision@5", "MRR", "mAP", "avg_latency_s"]
    lines.append("| pipeline | " + " | ".join(cols) + " |")
    lines.append("|" + "---|" * (len(cols) + 1))
    for name, runs in per_pipeline.items():
        per_query = [r["metrics"] for qid, r in runs.items() if qid != "_meta"]
        agg = summarize(per_query)
        avg_lat = runs["_meta"]["total_query_time_s"] / runs["_meta"]["queries"]
        row = [name] + [fmt(agg[c]) if c in agg else "" for c in cols[:-1]] + [fmt(avg_lat)]
        lines.append("| " + " | ".join(row) + " |")

    lines.append("")
    lines.append("## Per-query")
    lines.append("")
    for q in gt["queries"]:
        relevant = q.get("contains") or []
        lines.append(f"### {q['id']} — {q.get('label', '')}")
        lines.append(f"_{len(relevant)} ground-truth match(es)_")
        lines.append("")
        lines.append("| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |")
        lines.append("|---|---|---|---|---|---|")
        for name, runs in per_pipeline.items():
            r = runs[q["id"]]
            m = r["metrics"]
            top5 = ", ".join(_short(a, set(relevant)) for a in r["ranked"][:5]) or "(none)"
            lines.append(f"| {name} | {fmt(m['recall@5'])} | {fmt(m['recall@20'])} | {fmt(m['RR'])} | {fmt(m['AP'])} | {top5} |")
        lines.append("")
    return "\n".join(lines)


def _short(asset_id: str, relevant: set[str]) -> str:
    """Trim asset_id for readability; mark true positives with a star."""
    tag = "★" if asset_id in relevant else ""
    return f"`{asset_id[:8]}`{tag}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gt", required=True, type=Path, help="ground truth YAML")
    ap.add_argument("--pipelines", required=True,
                    help="comma-sep pipeline names: current_titan,rekognition_faces,nova_mm_embed")
    ap.add_argument("--out", type=Path, default=None, help="markdown report path (default: results/<gt>.md)")
    args = ap.parse_args()

    gt = yaml.safe_load(args.gt.read_text())
    query_root = args.gt.parent

    names = [n.strip() for n in args.pipelines.split(",") if n.strip()]
    per_pipeline = {}
    for name in names:
        print(f"▌ running pipeline: {name}")
        per_pipeline[name] = run_pipeline(get(name), gt["queries"], query_root)

    report = render_markdown(gt, per_pipeline)
    print()
    print(report)

    out = args.out or (Path(__file__).resolve().parent.parent / "results" / (args.gt.stem + ".md"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report)
    print(f"\n✓ report → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
