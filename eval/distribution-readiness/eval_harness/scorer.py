"""Pure scoring over a brief + agent response. No I/O, no network.

Two score buckets:

- Reference-free (always computable). Did the agent emit a card? Does it
  have the required top-level shape? Do the summary counts line up with
  the actual assets list? Is the per-asset `missing` field actually a
  set difference between policy requirements and `have`? These are the
  guards that catch "the agent didn't produce a card" or "produced a
  card whose numbers don't add up."

- Reference-aware (only when `brief.reference` is a human-curated card).
  Overlap of asset_ids and policy requirements, delta on ready-count,
  territory match. This is the signal that answers "did the SYSTEM_PROMPT
  change make things better or worse?" — the whole point of the harness.
"""
from __future__ import annotations

import json
import re
from typing import Any

_CARD_TAG_RE = re.compile(r"<distribution_card>(.*?)</distribution_card>", re.DOTALL)


def extract_card(response_text: str) -> dict | None:
    """Pull `<distribution_card>...</distribution_card>` out of the response
    and parse it as JSON. Returns None when absent or malformed."""
    if not response_text:
        return None
    m = _CARD_TAG_RE.search(response_text)
    if not m:
        return None
    body = m.group(1).strip()
    if not body:
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


_REQUIRED_TOP_LEVEL = ("territory", "assets", "summary", "policy", "audience_fit")


def has_valid_shape(card: dict | None) -> bool:
    if not isinstance(card, dict):
        return False
    for key in _REQUIRED_TOP_LEVEL:
        if key not in card:
            return False
    if not isinstance(card.get("assets"), list):
        return False
    if not isinstance(card.get("summary"), dict):
        return False
    return True


def counts_consistent(card: dict | None) -> bool:
    """`summary.ready_count + summary.blocked_count == len(assets)` AND
    the per-asset `ready` booleans line up with those counts."""
    if not has_valid_shape(card):
        return False
    assert card is not None
    summary = card.get("summary") or {}
    rc = summary.get("ready_count")
    bc = summary.get("blocked_count")
    if not isinstance(rc, int) or not isinstance(bc, int):
        return False
    assets = card.get("assets") or []
    if rc + bc != len(assets):
        return False
    actual_ready = sum(1 for a in assets if a.get("ready") is True)
    actual_blocked = sum(1 for a in assets if a.get("ready") is False)
    return actual_ready == rc and actual_blocked == bc


def gap_computation_sound(card: dict | None) -> bool:
    """For every asset, `missing` must equal the set difference between
    `policy.requirements` and `have`. Order doesn't matter; duplicates
    inside either list are tolerated by set-ifying."""
    if not has_valid_shape(card):
        return False
    assert card is not None
    policy = card.get("policy") or {}
    req = set(policy.get("requirements") or [])
    for a in card.get("assets") or []:
        have = set(a.get("have") or [])
        missing = set(a.get("missing") or [])
        expected = req - have
        if missing != expected:
            return False
        actual_ready = len(missing) == 0
        if a.get("ready") is not actual_ready:
            return False
    return True


def _asset_ids(card: dict | None) -> set[str]:
    if not card:
        return set()
    out: set[str] = set()
    for a in card.get("assets") or []:
        aid = a.get("asset_id")
        if isinstance(aid, str) and aid:
            out.add(aid)
    return out


def _requirements(card: dict | None) -> set[str]:
    if not card:
        return set()
    policy = card.get("policy") or {}
    return set(policy.get("requirements") or [])


def score_reference_free(brief: dict, run: dict) -> dict[str, Any]:
    """Reference-free structural scores. Always runs."""
    response_text = run.get("response_text") or ""
    card = extract_card(response_text)
    out: dict[str, Any] = {
        "card_present":     card is not None,
        "card_valid_shape": has_valid_shape(card),
    }
    if not out["card_valid_shape"]:
        return out

    assert card is not None
    assets = card.get("assets") or []
    summary = card.get("summary") or {}
    out["n_assets"]  = len(assets)
    out["n_ready"]   = int(summary.get("ready_count") or 0)
    out["n_blocked"] = int(summary.get("blocked_count") or 0)
    out["summary_counts_consistent"] = counts_consistent(card)
    out["gap_computation_sound"]     = gap_computation_sound(card)
    out["has_cleared_assets"]        = len(assets) > 0
    out["has_audience_fit"]          = len((card.get("audience_fit") or {}).get("candidates") or []) > 0

    expected = brief.get("expected") or {}

    # Territory match.
    want = str(expected.get("territory") or "").strip().upper()
    got  = str(card.get("territory") or "").strip().upper()
    if want:
        out["territory_matches_brief"] = want == got

    # Policy presence.
    min_req = expected.get("min_policy_requirements")
    if isinstance(min_req, int):
        out["policy_requirements_present"] = len(_requirements(card)) >= min_req

    # Elapsed-time budget.
    cap = expected.get("max_elapsed_ms")
    if isinstance(cap, int) and cap > 0:
        out["elapsed_within_cap"] = int(run.get("elapsed_ms") or 0) <= cap

    return out


def score_vs_reference(brief: dict, run: dict) -> dict[str, Any]:
    """Reference-aware scores. Returns {} when `brief.reference` is absent."""
    ref = brief.get("reference")
    if not isinstance(ref, dict):
        return {}
    card = extract_card(run.get("response_text") or "")
    if card is None:
        return {"card_present": False}

    out: dict[str, Any] = {}
    agent_ids = _asset_ids(card)
    ref_ids   = _asset_ids(ref)
    if ref_ids:
        out["asset_recall"] = round(len(agent_ids & ref_ids) / len(ref_ids), 3)
    if agent_ids:
        out["asset_precision"] = round(len(agent_ids & ref_ids) / len(agent_ids), 3)
    if ref_ids and agent_ids:
        inter = len(agent_ids & ref_ids)
        union = len(agent_ids | ref_ids)
        out["asset_jaccard"] = round(inter / union, 3)

    agent_req = _requirements(card)
    ref_req   = _requirements(ref)
    if ref_req and agent_req:
        inter = len(agent_req & ref_req)
        union = len(agent_req | ref_req)
        out["requirements_jaccard"] = round(inter / union, 3)

    agent_rc = int((card.get("summary") or {}).get("ready_count") or 0)
    ref_rc   = int((ref.get("summary")  or {}).get("ready_count") or 0)
    out["ready_count_delta"] = agent_rc - ref_rc

    out["territory_match"] = (
        str(card.get("territory") or "").strip().upper()
        == str(ref.get("territory") or "").strip().upper()
    )
    return out


def score(brief: dict, run: dict) -> dict[str, Any]:
    """Full score bundle. Shape:
    {
      "reference_free":  {...},
      "reference_aware": {...}   # empty when brief has no reference
    }"""
    return {
        "reference_free":  score_reference_free(brief, run),
        "reference_aware": score_vs_reference(brief, run),
    }
