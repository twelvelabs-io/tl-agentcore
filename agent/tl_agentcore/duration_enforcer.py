"""Runtime-side enforcement of the duration target in the producer's brief.

The SYSTEM_PROMPT in agent.py asks the model to land within ±10% (or ±3s) of
any explicit duration target. In practice the model frequently misses by
10-20% — the math is too easy to fudge. This module wraps the agent's final
text after `agent.stream_async()` and:

  1. Parses an explicit duration target from the user's brief.
  2. Extracts the `<plan>...</plan>` JSON.
  3. Sums actual `(end_time - start_time)` across scene primaries.
  4. If the sum is outside the band, mutates the plan deterministically:
       - SHORT: extend primary clips' `end_time` toward the cut-type cap,
                spreading the gap proportionally across all clips. Stops at
                each clip's cap; if maxed and still short, leaves a note.
       - OVER:  trim the longest clips toward the cut-type minimum, then if
                still over, drop the lowest-rank scene entirely.
  5. Rewrites `total_estimated_duration` to match the actual new sum.
  6. Returns a short note explaining what changed for the chat-facing prose.

The plan's `cut_type` field (set by the agent) selects the per-clip cap
range. Unknown/missing values default to the "narrative" range, which is
the most permissive and least likely to over-trim.
"""

from __future__ import annotations

import json
import re
from typing import Optional, Tuple

# Per-clip duration ranges by cut type. MUST stay in lockstep with the table
# in SYSTEM_PROMPT step 2. If you edit that table, edit here too.
CLIP_DUR_RANGE: dict[str, tuple[float, float]] = {
    "sizzle":    (3.0, 7.0),
    "narrative": (5.0, 12.0),
    "montage":   (2.0, 5.0),
    "mood":      (5.0, 15.0),
    "highlight": (5.0, 15.0),
    "rough_cut": (10.0, 30.0),
    # Aliases — the agent's cut-type table uses full phrases ("sizzle reel",
    # "narrative trailer", "highlight reel") but the JSON sometimes emits
    # the short form. Index both so the lookup matches either.
    "sizzle reel":     (3.0, 7.0),
    "sizzle_reel":     (3.0, 7.0),
    "narrative trailer": (5.0, 12.0),
    "narrative_trailer": (5.0, 12.0),
    "mood reel":     (5.0, 15.0),
    "mood_reel":     (5.0, 15.0),
    "mood reel / b-roll": (5.0, 15.0),
    "b-roll":        (5.0, 15.0),
    "highlight reel": (5.0, 15.0),
    "highlight_reel": (5.0, 15.0),
    "rough cut":     (10.0, 30.0),
    "rough":         (10.0, 30.0),
    "doc":           (10.0, 30.0),
    "documentary":   (10.0, 30.0),
}
DEFAULT_RANGE = CLIP_DUR_RANGE["narrative"]


def _fuzzy_caps(cut_type: str) -> tuple[float, float] | None:
    """Last-resort: match by keyword substring. Lets variant phrasings like
    'sizzle reel — kinetic' or 'documentary rough cut' still resolve."""
    for key, val in CLIP_DUR_RANGE.items():
        if key in cut_type:
            return val
    return None


# Brief-side cut-type inference. The agent frequently forgets to emit the
# `cut_type` field in its JSON, which means the enforcer used to fall back to
# narrative defaults and never trim sizzle/montage plans down to their tight
# per-clip caps. When `plan.cut_type` is missing, we sniff the brief for the
# same keywords the SYSTEM_PROMPT's classifier table uses — sizzle / montage
# / mood / highlight / rough-cut / narrative — and use that.
_BRIEF_TYPE_KEYWORDS: list[tuple[str, list[str]]] = [
    # Order matters: more-specific terms first.
    ("rough_cut",  ["rough cut", "full assembly", "first cut", "first-pass", "documentary"]),
    ("montage",    ["montage", "rapid cuts", "music-video opener", "music video opener"]),
    ("sizzle",     ["sizzle", "teaser", "showcase"]),
    ("highlight",  ["highlight reel", "highlight", "best moments", "best plays", "plays"]),
    ("mood",       ["mood reel", "b-roll", "atmospheric", "vibe"]),
    ("narrative",  ["narrative trailer", "trailer", "three-act", "act 1", "act 2", "act 3"]),
]


def _infer_cut_type_from_brief(brief: str) -> str | None:
    if not brief:
        return None
    lower = brief.lower()
    for cut_type, kws in _BRIEF_TYPE_KEYWORDS:
        for kw in kws:
            if kw in lower:
                return cut_type
    return None

# Numeric duration target, in seconds: matches "45 seconds", "45-second",
# "45s", "45 sec", "1 minute", "2-minute", "1 min", "1m". Anchored so
# something like "S3 bucket" doesn't pretend to be 3 seconds.
_TARGET_PATTERNS = [
    # minutes — capture int, group(1)
    re.compile(r"\b(\d+(?:\.\d+)?)\s*[-–]?\s*minute[s]?\b", re.IGNORECASE),
    re.compile(r"\b(\d+(?:\.\d+)?)\s*min(?:s|ute|utes)?\b", re.IGNORECASE),
    # seconds — capture, group(1)
    re.compile(r"\b(\d+(?:\.\d+)?)\s*[-–]?\s*second[s]?\b", re.IGNORECASE),
    re.compile(r"\b(\d+(?:\.\d+)?)\s*sec(?:s|ond|onds)?\b", re.IGNORECASE),
    re.compile(r"\b(\d+(?:\.\d+)?)\s*s\b(?!\w)", re.IGNORECASE),
]

PLAN_BLOCK_RE = re.compile(r"<plan>([\s\S]*?)</plan>", re.IGNORECASE)
JSON_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$", re.IGNORECASE)


def _brief_substring(prompt: str) -> str:
    """The UI wraps each rough-cut request as
        AGENT_INSTRUCTIONS \\n\\n--- \\n\\nBrief: <user brief>\\n\\n…
    AGENT_INSTRUCTIONS contains the phrase "between 30 seconds and 4 minutes"
    (it explains the full-cut range). If we scan the entire prompt for the
    first duration number we get 30, NOT the user's actual target. Always
    prefer the substring AFTER 'Brief:' when that marker is present —
    that's where the user's intent lives."""
    if not prompt:
        return ""
    idx = prompt.lower().find("brief:")
    if idx >= 0:
        return prompt[idx + len("brief:"):]
    return prompt


# Higher-precision target patterns: hyphenated "<N>-second" (anchored to the
# cut name) or explicit "Target N <unit>" / "Aim for N <unit>". Match these
# FIRST; only fall back to the loose "<N> seconds" pattern when the brief
# clearly contains just one numeric phrase.
_HARD_TARGET_PATTERNS = [
    re.compile(r"\b(?:target|aim(?:\s+for)?)\s+~?(\d+(?:\.\d+)?)\s*(minute[s]?|min(?:s|ute|utes)?|second[s]?|sec(?:onds)?|s)\b", re.IGNORECASE),
    re.compile(r"\b(\d+(?:\.\d+)?)[-–](second|sec|minute|min)s?\b", re.IGNORECASE),
    re.compile(r"\b(\d+(?:\.\d+)?)\s*(minute[s]?|min(?:s)?|second[s]?|sec(?:onds)?)\s+total\b", re.IGNORECASE),
]


def parse_target_seconds(prompt: str) -> Optional[float]:
    """Return the explicit duration target in seconds, or None if absent.
    Scans the BRIEF portion of the wrapped prompt only — the AGENT_INSTRUCTIONS
    prefix mentions "30 seconds" generically, which would otherwise clobber
    the actual target. Uses two-tier matching:
      1. High-precision patterns ("Target 45 seconds", "45-second", "<N>
         seconds total") — these unambiguously denote the cut's total.
      2. Loose patterns ("45 seconds", "1 minute", "45s") as a last resort.
    """
    text = _brief_substring(prompt)
    if not text:
        return None

    for pat in _HARD_TARGET_PATTERNS:
        m = pat.search(text)
        if m:
            try:
                n = float(m.group(1))
            except ValueError:
                continue
            unit_or_full = m.group(2) if m.lastindex and m.lastindex >= 2 else ""
            return n * 60.0 if unit_or_full and unit_or_full.lower().startswith("m") else n

    # Loose fallback — minutes first to avoid "1 minute" being picked up as 1s.
    for pat in _TARGET_PATTERNS[:2]:
        m = pat.search(text)
        if m:
            try:
                return float(m.group(1)) * 60.0
            except ValueError:
                pass
    for pat in _TARGET_PATTERNS[2:]:
        m = pat.search(text)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                pass
    return None


def _hms_to_sec(t: str) -> float:
    """HH:MM:SS, MM:SS, or plain SS → float seconds."""
    if t is None:
        return 0.0
    parts = str(t).strip().split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return 0.0
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    if len(nums) == 1:
        return nums[0]
    return 0.0


def _sec_to_hms(seconds: float) -> str:
    """Float seconds → HH:MM:SS, matching the agent's emit format."""
    s = max(0, int(round(seconds)))
    h, rem = divmod(s, 3600)
    m, ss = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{ss:02d}"


def _sec_to_mmss(seconds: float) -> str:
    """Float seconds → MM:SS for `total_estimated_duration`."""
    s = max(0, int(round(seconds)))
    m, ss = divmod(s, 60)
    return f"{m:02d}:{ss:02d}"


def _primary_clip(scene: dict) -> Optional[dict]:
    """The primary clip is the first item in `clips`. Defensive against
    malformed scenes (missing clips list, empty list)."""
    clips = scene.get("clips") if isinstance(scene, dict) else None
    if not isinstance(clips, list) or not clips:
        return None
    return clips[0] if isinstance(clips[0], dict) else None


def _clip_dur(clip: Optional[dict]) -> float:
    if not isinstance(clip, dict):
        return 0.0
    return max(0.0, _hms_to_sec(clip.get("end_time", "")) - _hms_to_sec(clip.get("start_time", "")))


def _set_clip_end_relative(clip: dict, new_duration: float) -> None:
    """Anchor `start_time`, set `end_time = start_time + new_duration`."""
    start = _hms_to_sec(clip.get("start_time", ""))
    clip["end_time"] = _sec_to_hms(start + max(0.0, new_duration))


def _extract_plan_block(text: str) -> Optional[Tuple[str, dict, int, int]]:
    """Find the <plan>...</plan> block and parse the JSON inside it.
    Returns (raw_inner, parsed_dict, match_start, match_end) or None."""
    m = PLAN_BLOCK_RE.search(text)
    if not m:
        return None
    inner = m.group(1).strip()
    fence_match = JSON_FENCE_RE.match(inner)
    if fence_match:
        inner = fence_match.group(1).strip()
    try:
        parsed = json.loads(inner)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    return inner, parsed, m.start(), m.end()


def _adjust_short(plan: dict, gap: float, cap_high: float) -> Tuple[float, bool]:
    """Extend primary clips' end_time to close `gap` seconds. Spreads
    proportionally across all primaries, capped per-clip at `cap_high`.
    Returns (actual_added, fully_closed)."""
    if gap <= 0:
        return 0.0, True
    scenes = plan.get("scenes") or []
    primaries = [(_primary_clip(s), s) for s in scenes if isinstance(s, dict)]
    primaries = [(c, s) for c, s in primaries if c is not None]
    if not primaries:
        return 0.0, False

    remaining = gap
    added_total = 0.0
    safety = 8
    while remaining > 0.01 and safety > 0:
        safety -= 1
        active = [(c, s) for c, s in primaries if _clip_dur(c) < cap_high - 0.01]
        if not active:
            break
        # Compute share ONCE per outer iteration — every active clip gets
        # the same nominal increment this pass. Some will be capped early
        # (their `allowed` is smaller than `share`), so we loop again with
        # the leftover spread across whoever still has headroom.
        share = remaining / len(active)
        for clip, _scene in active:
            cur = _clip_dur(clip)
            allowed = max(0.0, cap_high - cur)
            add = min(share, allowed)
            if add <= 0:
                continue
            _set_clip_end_relative(clip, cur + add)
            added_total += add
            remaining -= add
    return added_total, remaining <= 0.01


def _adjust_long(plan: dict, excess: float, cap_low: float) -> Tuple[float, bool]:
    """Trim primary clips' end_time to remove `excess` seconds. Trims the
    longest clips first, floored at `cap_low`. If still over after every
    primary hits cap_low, drops the lowest-rank scene to claw back more."""
    if excess <= 0:
        return 0.0, True
    scenes = plan.get("scenes") or []
    primaries = [(idx, _primary_clip(s), s) for idx, s in enumerate(scenes) if isinstance(s, dict)]
    primaries = [(i, c, s) for i, c, s in primaries if c is not None]
    if not primaries:
        return 0.0, False

    removed_total = 0.0
    remaining = excess
    safety = 8
    while remaining > 0.01 and safety > 0:
        safety -= 1
        active = [(i, c, s) for i, c, s in primaries if _clip_dur(c) > cap_low + 0.01]
        if not active:
            break
        # Compute the per-clip share ONCE per outer pass (not inside the
        # inner loop — otherwise share decays as `remaining` shrinks and
        # the cut becomes lopsided). Longest clips still get hit first
        # because we sort that way, but everyone gets the same nominal cut.
        share = remaining / len(active)
        active.sort(key=lambda t: _clip_dur(t[1]), reverse=True)
        for _idx, clip, _scene in active:
            cur = _clip_dur(clip)
            allowed = max(0.0, cur - cap_low)
            cut = min(share, allowed)
            if cut <= 0:
                continue
            _set_clip_end_relative(clip, cur - cut)
            removed_total += cut
            remaining -= cut

    if remaining > 0.01 and len(primaries) > 1:
        # Still too long. Drop the lowest-rank primary (or last scene if
        # rank info missing).
        def scene_key(t):
            _, c, _ = t
            rank = c.get("rank")
            return rank if isinstance(rank, (int, float)) else 10**6
        primaries.sort(key=scene_key, reverse=True)
        drop_idx = primaries[0][0]
        drop_scene = scenes[drop_idx]
        drop_dur = _clip_dur(_primary_clip(drop_scene))
        del scenes[drop_idx]
        removed_total += drop_dur
        remaining -= drop_dur
    return removed_total, remaining <= 0.01


def _plan_total_seconds(plan: dict) -> float:
    return sum(_clip_dur(_primary_clip(s)) for s in (plan.get("scenes") or []) if isinstance(s, dict))


def enforce_duration_target(text: str, prompt: str) -> Tuple[str, Optional[str]]:
    """Post-process the agent's final text. Returns (possibly_corrected_text,
    note_or_None). The note (when non-None) is also worth appending to the
    chat prose so the producer sees what the runtime did."""
    target = parse_target_seconds(prompt)
    if target is None or target <= 0:
        return text, None

    extracted = _extract_plan_block(text)
    if extracted is None:
        return text, None
    _inner, plan, plan_start, plan_end = extracted

    current = _plan_total_seconds(plan)
    if current <= 0:
        return text, None

    band = max(3.0, 0.10 * target)
    delta = current - target  # positive = over target; negative = short
    if abs(delta) <= band:
        # Already inside the band — leave the plan untouched, but make sure
        # the total_estimated_duration matches the actual sum (model often
        # rounds inconsistently). Cheap to update; only rewrite if drift.
        existing = plan.get("total_estimated_duration")
        fixed = _sec_to_mmss(current)
        if existing != fixed:
            plan["total_estimated_duration"] = fixed
            new_plan_str = json.dumps(plan, indent=2)
            new_text = text[:plan_start] + f"<plan>\n{new_plan_str}\n</plan>" + text[plan_end:]
            return new_text, None
        return text, None

    # cut_type resolution order:
    #   1. plan["cut_type"] if the agent obeyed the schema
    #   2. inferred from the brief (sizzle / montage / mood / …)
    #   3. narrative as the last-resort default
    # Then resolve the (cap_low, cap_high) tuple by exact match → fuzzy
    # substring match → DEFAULT_RANGE.
    plan_cut_raw = plan.get("cut_type")
    if plan_cut_raw:
        cut_type = str(plan_cut_raw).strip().lower()
    else:
        cut_type = _infer_cut_type_from_brief(prompt) or "narrative"
    cap_low, cap_high = CLIP_DUR_RANGE.get(cut_type) or _fuzzy_caps(cut_type) or DEFAULT_RANGE
    # Stamp the resolved cut_type back onto the emitted plan so the UI's
    # downstream consumers see the right value (the test asserts on this).
    if not plan_cut_raw and cut_type:
        plan["cut_type"] = cut_type

    if delta < 0:
        _adjust_short(plan, -delta, cap_high)
    else:
        _adjust_long(plan, delta, cap_low)

    new_total = _plan_total_seconds(plan)
    plan["total_estimated_duration"] = _sec_to_mmss(new_total)

    new_plan_str = json.dumps(plan, indent=2)
    new_text = text[:plan_start] + f"<plan>\n{new_plan_str}\n</plan>" + text[plan_end:]

    direction = "extended" if delta < 0 else "trimmed"
    in_band_now = abs(new_total - target) <= band
    if in_band_now:
        note = (
            f"_[duration target: model emitted {int(round(current))}s vs "
            f"{int(round(target))}s target; runtime {direction} primaries "
            f"to {int(round(new_total))}s (within ±{int(round(band))}s band).]_"
        )
    else:
        note = (
            f"_[duration target: model emitted {int(round(current))}s vs "
            f"{int(round(target))}s target; runtime {direction} primaries "
            f"to {int(round(new_total))}s — per-clip cap blocked reaching "
            f"the band. Ask me to add or drop a beat to close further.]_"
        )
    return new_text, note
