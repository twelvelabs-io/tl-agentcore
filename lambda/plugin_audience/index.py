"""Reference AgentCore Gateway Lambda target: audience / customer-360.

Exposes three MCP tools to the agent:

  list_audiences()                        — enumerate cohorts
  lookup_audience(segment_id)             — full affinity profile for one cohort
  territory_fit(territory, genre?, age?)  — rank cohorts by Distribution-Readiness
                                            relevance for the territory + brief

The first two shadow (and replace) the identically-named in-process
tools. `territory_fit` is new in the plugin surface — it's the "in
this territory, drama works well with 35-54 and monetization is high"
answer the exec is asking for, and it's intentionally only available
via MCP so the plugin story is end-to-end: the territory-fit heuristic
is one of the pieces a customer rewires with their own analytics
stack.

Reads AUDIENCES_TABLE (hash key: segment_id). Same table the in-proc
version read — no data migration needed. See
agent/tl_agentcore/agent.py:lookup_audience for the row shape.
"""
import os
import boto3

_ddb = boto3.client("dynamodb")
AUDIENCES_TABLE = os.environ["AUDIENCES_TABLE"]


def _from_ddb(v):
    if v is None:
        return None
    if "S"    in v: return v["S"]
    if "N"    in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "NULL" in v: return None
    if "L"    in v: return [_from_ddb(x) for x in v["L"]]
    if "M"    in v: return {k: _from_ddb(x) for k, x in v["M"].items()}
    if "SS"   in v: return list(v["SS"])
    if "NS"   in v: return [float(n) if "." in n else int(n) for n in v["NS"]]
    return None


def _row_to_segment(item):
    return {k: _from_ddb(v) for k, v in item.items()}


def _scan_all():
    out = []
    kwargs = {"TableName": AUDIENCES_TABLE}
    while True:
        r = _ddb.scan(**kwargs)
        out.extend(_row_to_segment(it) for it in r.get("Items", []))
        if "LastEvaluatedKey" not in r:
            return out
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]


# ─── tool: list_audiences ──────────────────────────────────────────────
def _list_audiences(_args):
    segments = _scan_all()
    return {"segments": [
        {
            "segment_id":    s.get("segment_id"),
            "name":          s.get("name"),
            "description":   s.get("description"),
            "demographics":  s.get("demographics"),
            "size_estimate": s.get("size_estimate"),
        }
        for s in segments
    ]}


# ─── tool: lookup_audience ─────────────────────────────────────────────
def _lookup_audience(args):
    segment_id = args.get("segment_id")
    if not isinstance(segment_id, str) or not segment_id:
        return {"error": "segment_id (string) is required"}
    r = _ddb.get_item(TableName=AUDIENCES_TABLE, Key={"segment_id": {"S": segment_id}})
    item = r.get("Item")
    if not item:
        return {"segment_id": segment_id, "found": False, "message": "No audience segment with that id."}
    return {**_row_to_segment(item), "found": True}


# ─── tool: territory_fit ───────────────────────────────────────────────
# Heuristic ranking — not a real analytics backend. The point of
# exposing this as a plugin is that the customer rewrites it with
# their own cohort-mix / revenue model.
#
# Score components:
#   - territory match (segment claims the territory in `markets` or
#     `demographics.territory` → +1.0, otherwise 0)
#   - genre affinity (segment's `genre_affinity[<genre>]` lookup;
#     anything > 1.0 is a positive signal, scaled)
#   - age-band overlap (segment's `demographics.age` vs. requested
#     age band, substring/overlap match)
#   - size_estimate (larger reachable cohort = better monetization
#     proxy; log-scaled)
def _territory_fit(args):
    territory = (args.get("territory") or "").strip().upper()
    genre     = (args.get("genre") or "").strip().lower()
    age_band  = (args.get("age_band") or "").strip()
    if not territory:
        return {"error": "territory (string) is required"}

    segments = _scan_all()
    ranked = []
    for s in segments:
        score = 0.0
        reasons = []

        markets = s.get("markets") or []
        demo    = s.get("demographics") or {}
        demo_territory = (demo.get("territory") or "").upper() if isinstance(demo, dict) else ""
        if (isinstance(markets, list) and territory in [str(m).upper() for m in markets]) or demo_territory == territory:
            score += 1.0
            reasons.append(f"segment serves {territory}")
        else:
            # Not available in this territory — skip entirely rather
            # than returning a 0-score row that pollutes the ranking.
            continue

        if genre:
            affinity = (s.get("genre_affinity") or {}).get(genre) if isinstance(s.get("genre_affinity"), dict) else None
            if isinstance(affinity, (int, float)):
                if affinity >= 1.0:
                    gained = min(2.0, (affinity - 1.0) * 1.5)
                    score += gained
                    reasons.append(f"{genre} affinity index {affinity:.2f} (+{gained:.2f})")
                else:
                    reasons.append(f"{genre} affinity index {affinity:.2f} — under-indexed, no boost")

        if age_band:
            seg_age = (demo.get("age") or "") if isinstance(demo, dict) else ""
            if seg_age and (age_band in seg_age or seg_age in age_band):
                score += 0.5
                reasons.append(f"age overlap: segment {seg_age!r} vs. brief {age_band!r}")

        size = s.get("size_estimate")
        if isinstance(size, (int, float)) and size > 0:
            import math
            size_bonus = min(1.0, math.log10(size) / 7.0)  # 10M viewers caps the bonus
            score += size_bonus
            reasons.append(f"reach {int(size):,} viewers (+{size_bonus:.2f})")

        ranked.append({
            "segment_id": s.get("segment_id"),
            "name":       s.get("name"),
            "score":      round(score, 3),
            "reasons":    reasons,
        })

    ranked.sort(key=lambda r: r["score"], reverse=True)
    return {
        "territory":  territory,
        "genre":      genre or None,
        "age_band":   age_band or None,
        "candidates": ranked,
        "method":     "heuristic (territory match + genre_affinity + age overlap + log size_estimate)",
    }


# ─── dispatcher ────────────────────────────────────────────────────────
_TOOLS = {
    "list_audiences":  _list_audiences,
    "lookup_audience": _lookup_audience,
    "territory_fit":   _territory_fit,
}


def handler(event, _context):
    tool = event.get("tool")
    args = event.get("arguments") or {}
    fn = _TOOLS.get(tool)
    if not fn:
        return {"error": f"unknown tool: {tool!r}"}
    try:
        return fn(args)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
