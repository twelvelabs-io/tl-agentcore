#!/usr/bin/env python3
"""Build the kb_cache for a TwelveLabs knowledge store.

Mirrors what Jockey caches in its internal Postgres (mini_ontology +
content_profile + index_overview). Runs once per KS, writes to the
DynamoDB table provisioned by infra/dynamodb.tf.

For each asset:
  1. List all items in the knowledge store.
  2. Call Pegasus with a structured prompt to extract:
       title (canonical), one_liner, mood_tags, primary_subjects,
       visual_style, role_hint
  3. Write to DDB at  pk=ks#<ks_id>  sk=ASSET#<asset_id>

After all assets are profiled, reduce them into a corpus overview
written at  pk=ks#<ks_id>  sk=OVERVIEW.

Usage:
  export KB_CACHE_TABLE=$(terraform -chdir=infra output -raw kb_cache_table)
  AWS_PROFILE=... TL_API_KEY=tlk_... \\
    python3 scripts/ingest_kb_cache.py ks_<id> [--limit N] [--workers 8] [--retries 2]

Idempotent — already-cached assets are skipped unless --force.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import boto3
import httpx

TL_BASE = os.environ.get("TL_BASE_URL", "https://api.twelvelabs.io/v1.3")
TL_KEY  = os.environ.get("TL_API_KEY")
REGION  = os.environ.get("AWS_REGION", "us-east-1")
TABLE   = os.environ.get("KB_CACHE_TABLE")

if not TL_KEY:
    print("error: TL_API_KEY env var required", file=sys.stderr)
    sys.exit(2)
if not TABLE:
    print("error: KB_CACHE_TABLE env var required (terraform -chdir=infra output -raw kb_cache_table)", file=sys.stderr)
    sys.exit(2)

ddb = boto3.client("dynamodb", region_name=REGION)


# ─── Pegasus prompt ──────────────────────────────────────────────────────────
# JSON-only output keeps the parser trivial and matches Jockey's
# get_content_profile shape (per-asset summary digest). The `key_entities`
# field is the foundation of Phase 2's entity-graph layer — Pegasus names
# the recognizable subjects per clip, and aggregate_entities() reduces them
# across the KS so the agent can answer "find every clip with X" without
# touching TL's entity-collections API.
PROFILE_PROMPT = """Analyze this video and respond with ONLY a single JSON object — no preamble, no code fences. Keys (all required):

{
  "title": "the canonical title or subject (short)",
  "one_liner": "one sentence describing what this video is",
  "mood_tags": ["3-6 tags from: tension, action, release, landscape, intimacy, coda, comedy, drama, horror, romance, suspense, kinetic, contemplative, ominous, triumphant, melancholy"],
  "primary_subjects": ["the 1-3 main on-screen subjects, named if recognizable"],
  "visual_style": "one of: cinematic, documentary, archival, animated, sports, news, music-video, vlog, mixed",
  "role_hint": "one of: cold-open, action-set-piece, emotional-coda, b-roll, hero-shot, transition, dialogue, atmospheric",
  "key_entities": [
    {
      "name": "canonical short name (Title Case for people, lowercase for objects/places)",
      "kind": "person | object | place | brand | animal",
      "appears": "brief one-line note on how/where the entity appears in this clip"
    }
  ]
}

key_entities should be 0-8 distinct entities you can identify with high confidence. Skip generic categories ("a man", "a tree") — only include entities you can name or describe specifically enough that another clip showing the same one would be recognizable.

Be terse. No prose around the JSON. Only valid JSON."""


def detect_marengo_index(ks_id: str) -> dict[str, Any] | None:
    """Find the Pegasus-enabled Marengo index whose video set best matches
    this KS. Heuristic: largest index with pegasus1.2 attached. Stored in
    OVERVIEW so the agent skips list_tl_indexes at runtime."""
    with httpx.Client(timeout=30) as client:
        r = client.get(
            f"{TL_BASE}/indexes",
            headers={"x-api-key": TL_KEY},
            params={"page_limit": 50},
        )
    if r.status_code >= 400:
        return None
    candidates = []
    for x in r.json().get("data", []):
        models = [m.get("model_name") for m in x.get("models", [])]
        if "pegasus1.2" in models and (x.get("video_count") or 0) >= 5:
            candidates.append({
                "index_id":    x.get("_id"),
                "name":        x.get("index_name"),
                "video_count": x.get("video_count"),
            })
    if not candidates:
        return None
    candidates.sort(key=lambda c: c.get("video_count") or 0, reverse=True)
    return candidates[0]


def list_items(ks_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    with httpx.Client(timeout=60) as client:
        while True:
            r = client.get(
                f"{TL_BASE}/knowledge-stores/{ks_id}/items",
                headers={"x-api-key": TL_KEY},
                params={"page_limit": 50, "page": page},
            )
            r.raise_for_status()
            j = r.json()
            data = j.get("data") or []
            items.extend(data)
            pi = j.get("page_info") or {}
            total_pages = pi.get("total_page") or 1
            if not data or page >= total_pages:
                break
            page += 1
    return items


def pegasus_profile(asset_id: str | None, item_id: str | None, retries: int) -> dict[str, Any]:
    """Call Pegasus with the structured prompt. Falls back to ksi_<uuid>
    when asset_id is missing."""
    body: dict[str, Any] = {
        "prompt": PROFILE_PROMPT,
        "stream": False,
        "max_tokens": 800,
    }
    if asset_id:
        body["video"] = {"type": "asset_id", "asset_id": asset_id}
    elif item_id:
        body["video"] = {"type": "knowledge_store_item", "knowledge_store_item_id": item_id}
    else:
        return {"error": "no asset_id or item_id"}

    attempt = 0
    last_err: str | None = None
    while attempt <= retries:
        try:
            with httpx.Client(timeout=240) as client:
                r = client.post(
                    f"{TL_BASE}/analyze",
                    headers={"x-api-key": TL_KEY, "content-type": "application/json"},
                    json=body,
                )
            if r.status_code >= 400:
                last_err = f"{r.status_code}: {r.text[:300]}"
                attempt += 1
                time.sleep(1.5 * attempt)
                continue
            text = (r.json().get("data") or "").strip()
            return _parse_profile(text)
        except httpx.HTTPError as e:
            last_err = str(e)
            attempt += 1
            time.sleep(1.5 * attempt)
    return {"error": last_err or "pegasus failed"}


_JSON_RE = re.compile(r"\{[\s\S]*\}")


def _parse_profile(raw: str) -> dict[str, Any]:
    m = _JSON_RE.search(raw)
    if not m:
        return {"raw": raw[:200], "error": "no_json"}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        return {"raw": raw[:200], "error": f"json_parse: {e}"}


def _to_ddb(value: Any) -> dict[str, Any]:
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        return {"L": [_to_ddb(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: _to_ddb(v) for k, v in value.items()}}
    return {"S": str(value)}


def write_asset(ks_id: str, asset_id: str, profile: dict[str, Any], item_id: str | None) -> None:
    item: dict[str, Any] = {
        "pk": {"S": f"ks#{ks_id}"},
        "sk": {"S": f"ASSET#{asset_id}"},
        "asset_id": {"S": asset_id},
        "ingested_at": {"N": str(int(time.time()))},
    }
    if item_id:
        item["item_id"] = {"S": item_id}
    for k, v in profile.items():
        if v is None or v == "":
            continue
        item[k] = _to_ddb(v)
    ddb.put_item(TableName=TABLE, Item=item)


def write_overview(ks_id: str, overview: dict[str, Any]) -> None:
    item: dict[str, Any] = {
        "pk": {"S": f"ks#{ks_id}"},
        "sk": {"S": "OVERVIEW"},
        "ingested_at": {"N": str(int(time.time()))},
    }
    for k, v in overview.items():
        if v is None or v == "":
            continue
        item[k] = _to_ddb(v)
    ddb.put_item(TableName=TABLE, Item=item)


def already_cached(ks_id: str, asset_id: str) -> bool:
    r = ddb.get_item(
        TableName=TABLE,
        Key={"pk": {"S": f"ks#{ks_id}"}, "sk": {"S": f"ASSET#{asset_id}"}},
        ProjectionExpression="asset_id",
    )
    return "Item" in r


def build_overview(ks_id: str, profiles: list[dict[str, Any]]) -> dict[str, Any]:
    from collections import Counter

    moods: Counter[str] = Counter()
    styles: Counter[str] = Counter()
    roles:  Counter[str] = Counter()
    titles: list[str] = []
    entity_count = 0
    for p in profiles:
        for m in (p.get("mood_tags") or []):
            if isinstance(m, str):
                moods[m.lower()] += 1
        s = p.get("visual_style")
        if isinstance(s, str):
            styles[s.lower()] += 1
        r = p.get("role_hint")
        if isinstance(r, str):
            roles[r.lower()] += 1
        t = p.get("title")
        if isinstance(t, str):
            titles.append(t)
        entity_count += len(p.get("key_entities") or [])
    return {
        "asset_count":   len(profiles),
        "top_moods":     [m for m, _ in moods.most_common(15)],
        "top_styles":    [s for s, _ in styles.most_common(8)],
        "top_roles":     [r for r, _ in roles.most_common(8)],
        "sample_titles": titles[:30],
        "entity_count":  entity_count,
    }


# ─── Phase 2: cross-asset entity graph ──────────────────────────────────────
# Per-asset profiles list named entities they contain. We reduce them across
# the KS into ENTITY#<canonical> records that the agent can read in one DDB
# GetItem to answer "find every clip with X" — the TL-independent analog of
# entity-collections / find_appearances.
#
# Canonicalization is intentionally simple: lowercase + strip + collapse
# whitespace. Pegasus's output is already reasonably consistent (Title Case
# for people, lowercase for objects per the prompt) so case-folding gives
# us most of the dedup we need. Cross-KS reconciliation (true Re-ID) needs
# a separate pipeline — that's Phase 3.

def _canonical(name: str) -> str:
    return " ".join(name.lower().split())


def aggregate_entities(
    ks_id: str,
    asset_to_profile: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Reduce per-asset key_entities into per-entity records keyed by
    canonical name. Returns {canonical_name: {name, kind, asset_ids[],
    appearance_count, aliases[]}}."""
    by_canonical: dict[str, dict[str, Any]] = {}
    for asset_id, profile in asset_to_profile.items():
        for ent in profile.get("key_entities") or []:
            if not isinstance(ent, dict):
                continue
            raw = ent.get("name")
            if not isinstance(raw, str) or not raw.strip():
                continue
            canon = _canonical(raw)
            kind = ent.get("kind") or "unknown"
            existing = by_canonical.setdefault(canon, {
                "canonical": canon,
                "name":      raw.strip(),
                "kind":      kind,
                "asset_ids": [],
                "aliases":   set(),
            })
            if asset_id not in existing["asset_ids"]:
                existing["asset_ids"].append(asset_id)
            if raw.strip() != existing["name"]:
                existing["aliases"].add(raw.strip())
    for v in by_canonical.values():
        v["appearance_count"] = len(v["asset_ids"])
        v["aliases"] = sorted(v["aliases"])
    return by_canonical


def write_entity(ks_id: str, canonical: str, record: dict[str, Any]) -> None:
    item: dict[str, Any] = {
        "pk":               {"S": f"ks#{ks_id}"},
        "sk":               {"S": f"ENTITY#{canonical}"},
        "canonical":        {"S": canonical},
        "name":             {"S": record["name"]},
        "kind":             {"S": record["kind"]},
        "asset_ids":        _to_ddb(record["asset_ids"]),
        "aliases":          _to_ddb(record["aliases"]),
        "appearance_count": {"N": str(record["appearance_count"])},
        "ingested_at":      {"N": str(int(time.time()))},
    }
    ddb.put_item(TableName=TABLE, Item=item)


def _query_all_profiles(ks_id: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    page: dict[str, Any] | None = None
    while True:
        kwargs: dict[str, Any] = {
            "TableName": TABLE,
            "KeyConditionExpression": "pk = :p AND begins_with(sk, :s)",
            "ExpressionAttributeValues": {
                ":p": {"S": f"ks#{ks_id}"},
                ":s": {"S": "ASSET#"},
            },
        }
        if page:
            kwargs["ExclusiveStartKey"] = page
        r = ddb.query(**kwargs)
        for it in r.get("Items", []):
            out.append({k: _from_ddb(v) for k, v in it.items()})
        page = r.get("LastEvaluatedKey")
        if not page:
            break
    return out


def _from_ddb(v: dict[str, Any]) -> Any:
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "L" in v: return [_from_ddb(x) for x in v["L"]]
    if "M" in v: return {k: _from_ddb(x) for k, x in v["M"].items()}
    if "NULL" in v: return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ks_id", help="Knowledge store id (form: ks_xxxxxxxx)")
    ap.add_argument("--limit", type=int, default=None, help="Cap number of assets (default: all)")
    ap.add_argument("--workers", type=int, default=8, help="Concurrent Pegasus calls")
    ap.add_argument("--retries", type=int, default=2, help="Per-asset Pegasus retries on failure")
    ap.add_argument("--force", action="store_true", help="Re-profile assets already in cache")
    args = ap.parse_args()

    print(f"→ listing items in {args.ks_id}")
    items = list_items(args.ks_id)
    print(f"  found {len(items)} items")
    if args.limit:
        items = items[: args.limit]
        print(f"  limited to {len(items)}")

    todo: list[tuple[str, str | None, dict[str, Any]]] = []
    for it in items:
        asset_id = it.get("asset_id") or it.get("_id") or ""
        item_id = it.get("_id") or it.get("id") or None
        if not asset_id:
            asset_id = item_id or ""
        if not asset_id:
            continue
        if not args.force and already_cached(args.ks_id, asset_id):
            continue
        todo.append((asset_id, item_id, it))

    print(f"→ profiling {len(todo)} assets · workers={args.workers}")

    profiles_for_overview: list[dict[str, Any]] = []
    failed = 0
    t0 = time.time()
    _HEX24 = re.compile(r"^[0-9a-f]{24}$", re.I)

    def work(asset_id: str, item_id: str | None) -> tuple[str, dict[str, Any]]:
        canonical = asset_id if _HEX24.match(asset_id) else None
        prof = pegasus_profile(canonical, item_id, args.retries)
        return asset_id, prof

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(work, a, i): (a, i) for a, i, _ in todo}
        for n, fut in enumerate(as_completed(futs), 1):
            asset_id, prof = fut.result()
            asset_id_orig, item_id = futs[fut]
            if prof.get("error"):
                failed += 1
                print(f"  [{n}/{len(todo)}] {asset_id_orig[:12]} ✗ {prof.get('error', '')[:60]}")
                continue
            try:
                write_asset(args.ks_id, asset_id_orig, prof, item_id)
                profiles_for_overview.append(prof)
                print(f"  [{n}/{len(todo)}] {asset_id_orig[:12]} ✓ {prof.get('title', '?')[:40]}")
            except Exception as e:
                failed += 1
                print(f"  [{n}/{len(todo)}] {asset_id_orig[:12]} ✗ ddb {e}")

    elapsed = time.time() - t0
    print(f"\n→ profiled {len(profiles_for_overview)} / {len(todo)} (failed {failed}) in {elapsed:.1f}s")

    if profiles_for_overview:
        all_profiles = profiles_for_overview
        if not args.force:
            all_profiles = _query_all_profiles(args.ks_id)
        overview = build_overview(args.ks_id, all_profiles)
        idx = detect_marengo_index(args.ks_id)
        if idx:
            overview["marengo_index_id"]    = idx.get("index_id")
            overview["marengo_index_name"]  = idx.get("name")
            overview["marengo_video_count"] = idx.get("video_count")
        write_overview(args.ks_id, overview)
        print(
            f"→ wrote overview · {overview['asset_count']} assets · "
            f"moods={overview['top_moods'][:5]} · "
            f"marengo={overview.get('marengo_index_id', '?')}"
        )

        # Cross-asset entity aggregation.
        asset_to_profile = {p.get("asset_id"): p for p in all_profiles if p.get("asset_id")}
        entities = aggregate_entities(args.ks_id, asset_to_profile)
        for canon, rec in entities.items():
            write_entity(args.ks_id, canon, rec)
        if entities:
            top = sorted(entities.values(), key=lambda r: r["appearance_count"], reverse=True)[:5]
            top_str = ", ".join(f"{r['name']}({r['appearance_count']})" for r in top)
            print(f"→ wrote {len(entities)} entity records · top: {top_str}")
        else:
            print("→ no key_entities extracted (Pegasus profiles had none)")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
