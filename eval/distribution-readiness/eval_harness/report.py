"""Collect per-brief score bundles and emit a JSON + Markdown report.

Same pattern as the sibling edl-quality harness. JSON file is the
authoritative artifact — diff two JSONs cleanly across runs. Markdown
is for humans skimming after.
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
        "card_present_rate":              _mean_bool(bundles, "reference_free.card_present"),
        "card_valid_shape_rate":          _mean_bool(bundles, "reference_free.card_valid_shape"),
        "territory_matches_brief_rate":   _mean_bool(bundles, "reference_free.territory_matches_brief"),
        "summary_counts_consistent_rate": _mean_bool(bundles, "reference_free.summary_counts_consistent"),
        "gap_computation_sound_rate":     _mean_bool(bundles, "reference_free.gap_computation_sound"),
        "has_audience_fit_rate":          _mean_bool(bundles, "reference_free.has_audience_fit"),
        "has_cleared_assets_rate":        _mean_bool(bundles, "reference_free.has_cleared_assets"),
        "elapsed_within_cap_rate":        _mean_bool(bundles, "reference_free.elapsed_within_cap"),
    }
    with_ref = [b for b in bundles if b.get("scores", {}).get("reference_aware")]
    if with_ref:
        agg["ref_scored_count"] = len(with_ref)
        agg["mean_asset_recall"]         = _mean_num(with_ref, "reference_aware.asset_recall")
        agg["mean_asset_precision"]      = _mean_num(with_ref, "reference_aware.asset_precision")
        agg["mean_asset_jaccard"]        = _mean_num(with_ref, "reference_aware.asset_jaccard")
        agg["mean_requirements_jaccard"] = _mean_num(with_ref, "reference_aware.requirements_jaccard")
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
    lines.append(f"# Distribution-readiness eval — {report['generated_at']}")
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
    lines.append("| id | card? | shape? | territory? | n_assets | ready/blk | counts? | gap? | aud? | elapsed_ms | err? |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for b in report["briefs"]:
        s  = b.get("scores", {})
        rf = s.get("reference_free", {})
        err = b.get("run", {}).get("error") or ""
        rb  = f"{rf.get('n_ready','—')}/{rf.get('n_blocked','—')}"
        lines.append(
            f"| {b.get('id','?')} "
            f"| {'✓' if rf.get('card_present') else '✗'} "
            f"| {'✓' if rf.get('card_valid_shape') else '✗'} "
            f"| {_tick(rf.get('territory_matches_brief'))} "
            f"| {rf.get('n_assets','—')} "
            f"| {rb} "
            f"| {_tick(rf.get('summary_counts_consistent'))} "
            f"| {_tick(rf.get('gap_computation_sound'))} "
            f"| {_tick(rf.get('has_audience_fit'))} "
            f"| {b.get('run',{}).get('elapsed_ms','—')} "
            f"| {err[:40]} |"
        )
    return "\n".join(lines) + "\n"


def _tick(v: Any) -> str:
    if v is True:
        return "✓"
    if v is False:
        return "✗"
    return "—"
