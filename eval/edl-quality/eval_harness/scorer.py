"""Pure scoring over a brief + agent response. No I/O, no network — this
is the piece that evolves fastest when we add new quality metrics, so
keeping it dependency-free makes it unit-testable at the raw function
level.

Two kinds of score:

- Reference-free (always computable). Does the response have a plan at
  all? Does the plan parse? Does its duration match the brief? Does
  the scene / clip count fall inside the brief's bands? These are the
  structural guards that catch "the agent didn't produce an EDL" or
  "produced one that violates its own constraints."

- Reference-aware (only when `brief.reference` is a human-produced
  plan). Asset-id overlap, duration delta, scene-count delta vs. a
  curated gold cut. These are the signal that "did the prompt change
  make things better or worse?" — which is the whole point of the
  harness.

Scores return a dict so the report can enumerate them without the
harness having to know the schema.
"""
from __future__ import annotations

import json
import re
from typing import Any

_PLAN_TAG_RE = re.compile(r"<plan>(.*?)</plan>", re.DOTALL)


def extract_plan(response_text: str) -> dict | None:
    """Pull the `<plan>...</plan>` block out of the agent's response and
    parse it as JSON. Returns None when the block is absent or malformed."""
    if not response_text:
        return None
    m = _PLAN_TAG_RE.search(response_text)
    if not m:
        return None
    body = m.group(1).strip()
    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def total_duration_s(plan: dict | None) -> float:
    """Sum of (end - start) across every clip in every scene. The agent's
    EDL schema uses `start_time` / `end_time` or `start` / `end` — this
    accepts both because the schema has shifted once and might again."""
    if not plan:
        return 0.0
    out = 0.0
    for scene in plan.get("scenes", []) or []:
        for clip in scene.get("clips", []) or []:
            s = clip.get("start_time", clip.get("start"))
            e = clip.get("end_time",   clip.get("end"))
            if isinstance(s, (int, float)) and isinstance(e, (int, float)) and e > s:
                out += float(e - s)
    return out


def collect_asset_ids(plan: dict | None) -> list[str]:
    """Flat list of primary asset_ids across the plan. Alternates aren't
    counted — they're candidates the user hasn't chosen. Deduped while
    preserving insertion order so the first-appearance signal survives."""
    if not plan:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for scene in plan.get("scenes", []) or []:
        for clip in scene.get("clips", []) or []:
            aid = clip.get("asset_id") or clip.get("mimir_id")
            if isinstance(aid, str) and aid and aid not in seen:
                seen.add(aid)
                out.append(aid)
    return out


def score_reference_free(brief: dict, response_text: str) -> dict[str, Any]:
    """Reference-free structural scores. Always runs."""
    plan = extract_plan(response_text)
    out: dict[str, Any] = {
        "plan_present":  plan is not None,
        "plan_scenes":   0,
        "plan_clips":    0,
        "plan_duration_s": 0.0,
    }
    if plan is None:
        return out

    scenes = plan.get("scenes", []) or []
    out["plan_scenes"] = len(scenes)
    out["plan_clips"]  = sum(len(s.get("clips", []) or []) for s in scenes)
    out["plan_duration_s"] = round(total_duration_s(plan), 2)

    con = brief.get("constraints") or {}

    # Duration band — compare against target with a tolerance of 10 %.
    target = con.get("target_duration_s")
    if isinstance(target, (int, float)) and target > 0:
        delta = abs(out["plan_duration_s"] - float(target))
        out["duration_abs_delta_s"] = round(delta, 2)
        out["duration_within_10pct"] = delta <= 0.10 * float(target)

    # Scene band.
    lo = con.get("min_scenes")
    hi = con.get("max_scenes")
    if isinstance(lo, int) and isinstance(hi, int) and lo > 0 and hi >= lo:
        out["scene_count_in_band"] = lo <= out["plan_scenes"] <= hi

    # Per-clip duration band.
    cmin = con.get("min_clip_duration_s")
    cmax = con.get("max_clip_duration_s")
    if isinstance(cmin, (int, float)) and isinstance(cmax, (int, float)) and cmin > 0 and cmax >= cmin:
        bad = 0
        for scene in scenes:
            for clip in scene.get("clips", []) or []:
                s = clip.get("start_time", clip.get("start"))
                e = clip.get("end_time",   clip.get("end"))
                if isinstance(s, (int, float)) and isinstance(e, (int, float)):
                    d = e - s
                    if d < cmin or d > cmax:
                        bad += 1
        out["clips_outside_duration_band"] = bad
        out["all_clips_in_band"]          = bad == 0

    return out


def score_vs_reference(brief: dict, response_text: str) -> dict[str, Any]:
    """Reference-aware scores. Returns {} when `brief.reference` is null
    or absent — the harness still records the reference-free score, but
    skips this bucket."""
    ref = brief.get("reference")
    if not isinstance(ref, dict):
        return {}
    plan = extract_plan(response_text)
    if plan is None:
        return {"plan_present": False}

    agent_ids = set(collect_asset_ids(plan))
    ref_ids   = set(collect_asset_ids(ref))

    out: dict[str, Any] = {}
    if ref_ids:
        out["asset_recall"]    = round(len(agent_ids & ref_ids) / len(ref_ids), 3)
    if agent_ids:
        out["asset_precision"] = round(len(agent_ids & ref_ids) / len(agent_ids), 3)
    if ref_ids and agent_ids:
        inter = len(agent_ids & ref_ids)
        union = len(agent_ids | ref_ids)
        out["asset_jaccard"]   = round(inter / union, 3)

    agent_dur = total_duration_s(plan)
    ref_dur   = total_duration_s(ref)
    if ref_dur > 0:
        out["duration_delta_s"]  = round(agent_dur - ref_dur, 2)
        out["duration_delta_pct"] = round((agent_dur - ref_dur) / ref_dur, 3)

    out["scene_count_delta"] = len(plan.get("scenes") or []) - len(ref.get("scenes") or [])
    return out


def score(brief: dict, response_text: str) -> dict[str, Any]:
    """Full score bundle. Shape:
    {
      "reference_free": {...},
      "reference_aware": {...}   # empty when brief has no reference
    }"""
    return {
        "reference_free":  score_reference_free(brief, response_text),
        "reference_aware": score_vs_reference(brief, response_text),
    }
