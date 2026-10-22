"""Collect per-brief score bundles and emit a JSON + Markdown report.

The JSON file is the authoritative artifact — downstream tooling (CI,
dashboards, git-tracked baselines) can diff two JSONs cleanly. The
Markdown table is for humans skimming the report after a run.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


def write(reports_dir: Path, bundles: list[dict[str, Any]]) -> dict[str, Path]:
    """Write `<reports_dir>/<ts>.json` and `<reports_dir>/<ts>.md`.
    Returns the two paths. Caller prints a one-line summary to stdout."""
    reports_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%dT%H%M%S")
    json_path = reports_dir / f"{ts}.json"
    md_path   = reports_dir / f"{ts}.md"

    report: dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "n_briefs":     len(bundles),
        "briefs":       bundles,
        "aggregate":    _aggregate(bundles),
    }
    json_path.write_text(json.dumps(report, indent=2))
    md_path.write_text(_markdown(report))
    return {"json": json_path, "md": md_path}


def _aggregate(bundles: list[dict[str, Any]]) -> dict[str, Any]:
    """Reference-free pass rates + averaged reference-aware scores."""
    n = len(bundles)
    if n == 0:
        return {}
    agg: dict[str, Any] = {
        "plan_present_rate":            _mean_bool(bundles, "reference_free.plan_present"),
        "duration_within_10pct_rate":   _mean_bool(bundles, "reference_free.duration_within_10pct"),
        "scene_count_in_band_rate":     _mean_bool(bundles, "reference_free.scene_count_in_band"),
        "all_clips_in_band_rate":       _mean_bool(bundles, "reference_free.all_clips_in_band"),
    }
    # Reference-aware only when any bundle actually had a reference.
    with_ref = [b for b in bundles if b.get("scores", {}).get("reference_aware")]
    if with_ref:
        agg["ref_scored_count"] = len(with_ref)
        agg["mean_asset_recall"]    = _mean_num(with_ref, "reference_aware.asset_recall")
        agg["mean_asset_precision"] = _mean_num(with_ref, "reference_aware.asset_precision")
        agg["mean_asset_jaccard"]   = _mean_num(with_ref, "reference_aware.asset_jaccard")
    return agg


def _get(d: dict, dotted: str) -> Any:
    cur: Any = d
    for p in dotted.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _mean_bool(bundles: list[dict], dotted: str) -> float | None:
    vals = [_get(b.get("scores", {}), dotted) for b in bundles]
    vals = [v for v in vals if isinstance(v, bool)]
    if not vals:
        return None
    return round(sum(1 for v in vals if v) / len(vals), 3)


def _mean_num(bundles: list[dict], dotted: str) -> float | None:
    vals = [_get(b.get("scores", {}), dotted) for b in bundles]
    vals = [v for v in vals if isinstance(v, (int, float))]
    if not vals:
        return None
    return round(sum(vals) / len(vals), 3)


def _markdown(report: dict[str, Any]) -> str:
    agg = report.get("aggregate") or {}
    lines: list[str] = []
    lines.append(f"# EDL-quality eval — {report['generated_at']}")
    lines.append("")
    lines.append(f"{report['n_briefs']} brief(s).")
    lines.append("")

    if agg:
        lines.append("## Aggregate")
        lines.append("")
        lines.append("| metric | value |")
        lines.append("|---|---|")
        for k, v in agg.items():
            lines.append(f"| {k} | {'—' if v is None else v} |")
        lines.append("")

    lines.append("## Per-brief")
    lines.append("")
    lines.append("| id | plan? | scenes | clips | dur_s | Δdur_s | asset_recall | elapsed_ms | err? |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for b in report["briefs"]:
        s  = b.get("scores", {})
        rf = s.get("reference_free", {})
        ra = s.get("reference_aware", {}) or {}
        err = b.get("run", {}).get("error") or ""
        lines.append(
            f"| {b.get('id','?')} "
            f"| {'✓' if rf.get('plan_present') else '✗'} "
            f"| {rf.get('plan_scenes','—')} "
            f"| {rf.get('plan_clips','—')} "
            f"| {rf.get('plan_duration_s','—')} "
            f"| {rf.get('duration_abs_delta_s','—')} "
            f"| {ra.get('asset_recall','—')} "
            f"| {b.get('run',{}).get('elapsed_ms','—')} "
            f"| {err[:40]} |"
        )
    return "\n".join(lines) + "\n"
