"""Strands Agent — tl-agentcore (AWS-only).

The agent ships with one retrieval primitive (Marengo + S3 Vectors), a
DDB-backed knowledge cache, image-grounded entity search (Titan + S3
Vectors), and one Bedrock Pegasus grounding tool. No TwelveLabs SaaS
call is made on the live path; every model the agent reaches is invoked
through Bedrock Marketplace under the customer's IAM.

  Tier 0 — Native AWS retrieval (S3 Vectors)
    vector_search                  — Bedrock Marengo embed → S3 Vectors ANN,
                                     three modality indexes, softmax fusion.
    find_entity_by_image           — Bedrock Titan multimodal embed →
                                     S3 Vectors entity-thumbs / entity-patches.

  Tier 1 — Cache (DynamoDB · sub-10ms)
    get_kb_overview                — Per-KS digest.
    list_kb_assets                 — Cached per-asset profiles, mood/role filters.
    lookup_asset_profile           — Single-asset cached digest.
    list_kb_events / lookup_event  — Multi-clip event clusters.
    find_cached_entity_appearances — Entity → asset_ids from the cross-asset
                                     entity graph (no model call).
    list_cached_entities           — All cross-asset entities (by kind, etc.).

  Tier 2 — On-demand grounding (Bedrock Pegasus 1.2)
    pegasus_analyze                — One clip → take-note via s3Location.

  Ancillary (domain DDB lookups)
    lookup_rights                  — DDB licensing record.
    list_audiences / lookup_audience — DDB audience cohorts.

The agent picks the cheapest tool that answers the question. See SYSTEM_PROMPT
for the routing playbook.
"""

from __future__ import annotations

import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import boto3
import httpx
from strands import Agent, tool

# ─── Configuration via env ──────────────────────────────────────────────────
MODEL_ID = os.environ.get(
    "AGENT_MODEL_ID",
    # Sonnet 4.6 — frontier-class reasoning model on Bedrock. With kb_cache
    # pre-built, the agent finishes in fewer turns; per-turn latency stays
    # well under the demo budget.
    "us.anthropic.claude-sonnet-4-6",
)
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

# S3 Vectors (AWS-native retrieval). Three modality indexes + optional
# legacy single-index layout. See vector_search docstring for layout rules.
MARENGO_BEDROCK_MODEL_ID = os.environ.get(
    "MARENGO_BEDROCK_MODEL_ID",
    "us.twelvelabs.marengo-embed-3-0-v1:0",
)
VECTOR_BUCKET_NAME = os.environ.get("VECTOR_BUCKET_NAME")
VECTOR_INDEX_NAME = os.environ.get("VECTOR_INDEX_NAME")
VECTOR_INDEX_VISUAL = os.environ.get("VECTOR_INDEX_VISUAL", "asset-embeddings-visual")
VECTOR_INDEX_AUDIO = os.environ.get("VECTOR_INDEX_AUDIO", "asset-embeddings-audio")
VECTOR_INDEX_TRANSCRIPTION = os.environ.get("VECTOR_INDEX_TRANSCRIPTION", "asset-embeddings-transcription")
_MODALITY_INDEX_MAP = {
    "visual": VECTOR_INDEX_VISUAL,
    "audio": VECTOR_INDEX_AUDIO,
    "transcription": VECTOR_INDEX_TRANSCRIPTION,
}

# Pegasus runs on Bedrock against mirrored S3 bytes — no TwelveLabs SaaS
# involvement on the live path.
PEGASUS_BEDROCK_MODEL_ID = os.environ.get(
    "PEGASUS_BEDROCK_MODEL_ID",
    "us.twelvelabs.pegasus-1-2-v1:0",
)
CLIPS_BUCKET_NAME = os.environ.get("CLIPS_BUCKET_NAME")
CLIPS_BUCKET_OWNER = os.environ.get("CLIPS_BUCKET_OWNER")  # account id

# DDB tables (cache + domain lookups).
KB_CACHE_TABLE = os.environ.get("KB_CACHE_TABLE")
RIGHTS_TABLE = os.environ.get("RIGHTS_TABLE")
AUDIENCES_TABLE = os.environ.get("AUDIENCES_TABLE")

_s3v = boto3.client("s3vectors", region_name=AWS_REGION)
_bedrock_rt = boto3.client("bedrock-runtime", region_name=AWS_REGION)
_ddb = boto3.client("dynamodb", region_name=AWS_REGION)


def _secs_to_hhmmss(s) -> str:
    try:
        s = float(s)
    except Exception:
        return "00:00:00"
    total = max(0, int(round(s)))
    h, rem = divmod(total, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


# ═══ DDB helpers (kb_cache, rights, audiences) ═══════════════════════════════

def _ddb_value(v):
    if v is None:
        return None
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "NULL" in v: return None
    if "L" in v: return [_ddb_value(x) for x in v["L"]]
    if "M" in v: return {k: _ddb_value(x) for k, x in v["M"].items()}
    if "SS" in v: return list(v["SS"])
    if "NS" in v: return [float(x) if "." in x else int(x) for x in v["NS"]]
    return None


def _ddb_to_python(item):
    if item is None:
        return None
    return {k: _ddb_value(v) for k, v in item.items()}


def _ddb_kb_get(pk: str, sk: str) -> dict | None:
    if not KB_CACHE_TABLE:
        return None
    r = _ddb.get_item(TableName=KB_CACHE_TABLE, Key={"pk": {"S": pk}, "sk": {"S": sk}})
    return _ddb_to_python(r.get("Item"))


def _ddb_kb_query(pk: str, sk_prefix: str, limit: int | None = None) -> list[dict]:
    if not KB_CACHE_TABLE:
        return []
    items: list[dict] = []
    page: dict | None = None
    while True:
        kwargs: dict = {
            "TableName": KB_CACHE_TABLE,
            "KeyConditionExpression": "pk = :p AND begins_with(sk, :s)",
            "ExpressionAttributeValues": {":p": {"S": pk}, ":s": {"S": sk_prefix}},
        }
        if page:
            kwargs["ExclusiveStartKey"] = page
        r = _ddb.query(**kwargs)
        for it in r.get("Items", []):
            obj = _ddb_to_python(it)
            if obj:
                items.append(obj)
                if limit and len(items) >= limit:
                    return items
        page = r.get("LastEvaluatedKey")
        if not page:
            break
    return items


# ═══ Tier 0: AWS-native retrieval (S3 Vectors) ════════════════════════════════
# Intent-routed multi-modal fusion. Marengo 3.0 emits visual + audio +
# transcription embeddings per clip; this tool queries all three and
# score-fuses with softmax weights derived from query-anchor similarity.

ROUTING_ANCHORS = {
    "visual":        "On-screen action, shots, framing, camera movement, lighting, and composition.",
    "audio":         "Music score, sound design, sound effects, ambience, and non-speech audio.",
    "transcription": "Spoken dialogue, narration, voice-over, and on-screen speech.",
}
ROUTING_ALPHA = 10.0
ROUTING_PER_MOD_K = 25

_anchor_embeddings_cache: Optional[dict[str, list[float]]] = None


def _embed_text(query_text: str) -> list[float]:
    """Marengo text encoder via Bedrock InvokeModel. 512-dim float vector."""
    body = {"inputType": "text", "text": {"inputText": query_text}}
    resp = _bedrock_rt.invoke_model(
        modelId=MARENGO_BEDROCK_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
    )
    payload = json.loads(resp["body"].read())
    seg = (payload.get("data") or [{}])[0]
    v = seg.get("embedding") or []
    if not v:
        raise RuntimeError(f"Marengo text embed returned no vector: {json.dumps(payload)[:300]}")
    return v


def _anchor_embeddings() -> dict[str, list[float]]:
    global _anchor_embeddings_cache
    if _anchor_embeddings_cache is not None:
        return _anchor_embeddings_cache
    out: dict[str, list[float]] = {}
    for modality, text in ROUTING_ANCHORS.items():
        out[modality] = _embed_text(text)
    _anchor_embeddings_cache = out
    return out


def _cosine(a: list[float], b: list[float]) -> float:
    dot = 0.0; na = 0.0; nb = 0.0
    for x, y in zip(a, b):
        dot += x * y; na += x * x; nb += y * y
    if na == 0 or nb == 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def _routing_weights(query_vec: list[float]) -> dict[str, float]:
    anchors = _anchor_embeddings()
    sims = {m: _cosine(query_vec, vec) for m, vec in anchors.items()}
    scaled = {m: ROUTING_ALPHA * s for m, s in sims.items()}
    mx = max(scaled.values())
    exps = {m: math.exp(s - mx) for m, s in scaled.items()}
    total = sum(exps.values()) or 1.0
    return {m: v / total for m, v in exps.items()}


_INSTRUCTIONAL_ROLE_HINTS = {"instructional", "tutorial", "lecture", "training"}


def _skip_ranges_for_asset(knowledge_store_id: str, asset_id: str) -> list[tuple[float, float]]:
    """Fetch the per-asset skip ranges from kb_cache. Two layers:

    1. Explicit `skip_ranges` Pegasus tagged at ingest (credits, studio
       logo, fade-to-black, title card, color bars, instructional regions).
    2. **Heuristic full-asset skip** when the profile's `role_hint` is in
       `_INSTRUCTIONAL_ROLE_HINTS`. Pegasus reliably labels asset-level
       intent in `role_hint` / `one_liner` / `visual_style` but is much
       less reliable at emitting a corresponding wide `skip_range`. When
       the role_hint says the whole asset is teaching content, we treat
       the whole duration as one synthetic instructional range so
       vector_search drops every candidate from that asset — regardless of
       which timestamp Marengo scored highly.

    Returns float (start, end) tuples. Missing/legacy assets return []."""
    row = _ddb_kb_get(f"ks#{knowledge_store_id}", f"ASSET#{asset_id}")
    if not row:
        return []
    out: list[tuple[float, float]] = []
    raw = row.get("skip_ranges")
    if isinstance(raw, list):
        for r in raw:
            if not isinstance(r, dict):
                continue
            try:
                s = float(r.get("start_sec", 0))
                e = float(r.get("end_sec", 0))
            except (TypeError, ValueError):
                continue
            if e > s:
                out.append((s, e))

    role_hint = str(row.get("role_hint", "") or "").strip().lower()
    one_liner = str(row.get("one_liner", "") or "").lower()
    visual_style = str(row.get("visual_style", "") or "").lower()
    is_instructional = (
        role_hint in _INSTRUCTIONAL_ROLE_HINTS
        or "instructional" in one_liner
        or ("documentary" == visual_style and "instructional" in one_liner)
    )
    if is_instructional:
        # Synthesize a [0, very-large] skip range. We don't know the exact
        # asset duration from this row, so use a value bigger than any
        # plausible clip end. The overlap check just needs `c_e > 0`.
        out.append((0.0, 1e9))
    return out


def _drop_skip_overlaps(fused: list[dict], knowledge_store_id: str, target_count: int) -> list[dict]:
    """Filter the post-fusion candidate list so anything overlapping a known
    skip range (credits / studio logo / fade-to-black / etc) is removed.
    Look up each unique asset once via ThreadPoolExecutor — vector_search
    is already inside one fan-out, but the kb_cache lookup is a cheap DDB
    GetItem so the added latency is small.

    Two overlap tests: the candidate's [c_s, c_e] overlaps a skip range
    [r_s, r_e] iff they intersect by more than EPS seconds. We drop on ANY
    overlap (not just contains-start) because even a partial credit overlap
    means part of the emitted clip would land on credits.
    """
    if not fused:
        return fused
    EPS = 0.5
    unique_assets = {r["asset_id"] for r in fused}
    skip_map: dict[str, list[tuple[float, float]]] = {}
    try:
        with ThreadPoolExecutor(max_workers=min(8, max(2, len(unique_assets)))) as ex:
            futs = {aid: ex.submit(_skip_ranges_for_asset, knowledge_store_id, aid) for aid in unique_assets}
            for aid, fut in futs.items():
                try:
                    skip_map[aid] = fut.result()
                except Exception as e:
                    print(f"vector_search: skip_ranges lookup failed for {aid}: {e}")
                    skip_map[aid] = []
    except Exception as e:
        print(f"vector_search: skip_ranges fan-out failed: {e}")
        return fused

    kept: list[dict] = []
    dropped = 0
    for r in fused:
        ranges = skip_map.get(r["asset_id"]) or []
        c_s = float(r.get("start_sec") or 0)
        c_e = float(r.get("end_sec") or 0)
        overlaps = False
        for s, e in ranges:
            if min(c_e, e) - max(c_s, s) > EPS:
                overlaps = True
                break
        if overlaps:
            dropped += 1
            continue
        kept.append(r)
        # Stop once we have plenty — we over-fetch top_k earlier so a few
        # filtered candidates don't starve the result list.
        if len(kept) >= max(target_count * 3, target_count + 5):
            break
    if dropped:
        print(f"vector_search: dropped {dropped} candidates overlapping skip_ranges (kept {len(kept)})")
    return kept


def _query_one_modality(query_vec, knowledge_store_id, modality: str, top_k: int):
    filters = []
    if knowledge_store_id:
        filters.append({"knowledge_store_id": knowledge_store_id})
    if VECTOR_INDEX_NAME:
        index_name = VECTOR_INDEX_NAME
        filters.append({"embedding_option": modality})
    else:
        index_name = _MODALITY_INDEX_MAP[modality]
    kwargs = {
        "vectorBucketName": VECTOR_BUCKET_NAME,
        "indexName": index_name,
        "topK": top_k,
        "queryVector": {"float32": query_vec},
        "returnDistance": True,
        "returnMetadata": True,
    }
    if len(filters) == 1:
        kwargs["filter"] = filters[0]
    elif len(filters) > 1:
        kwargs["filter"] = {"$and": filters}
    return _s3v.query_vectors(**kwargs)


@tool
def vector_search(
    query_text: str,
    knowledge_store_id: Optional[str] = None,
    k: int = 5,
) -> dict:
    """Multi-vector ranked clip retrieval over S3 Vectors. Embeds the query
    via Bedrock-hosted Marengo, runs three parallel ANN queries (visual,
    audio, transcription) softmax-fused by anchor similarity, and returns
    fine-grained clip timecodes. Use whenever you need ranked clips from
    the AWS-native index — this is the only retrieval primitive.

    Args:
        query_text: natural-language beat phrase. Visual queries lean visual;
            who-said-what leans transcription; what-is-heard leans audio.
        knowledge_store_id: optional metadata-filter for tenant scoping.
        k: how many clips to return (default 5).

    Returns:
        {clips: [{asset_id, start_time HH:MM:SS, end_time, rank, score,
        distance, dominant_modality}], query, routing_weights}.
    """
    if not query_text:
        return {"error": "query_text is required"}
    if not VECTOR_BUCKET_NAME:
        return {"error": "VECTOR_BUCKET_NAME not configured"}
    if not VECTOR_INDEX_NAME and not all(_MODALITY_INDEX_MAP.values()):
        return {"error": "vector index env vars not configured (set VECTOR_INDEX_NAME or VECTOR_INDEX_VISUAL/AUDIO/TRANSCRIPTION)"}

    try:
        query_vec = _embed_text(query_text)
    except Exception as e:
        return {"error": f"embed failed: {e}"}
    try:
        weights = _routing_weights(query_vec)
    except Exception as e:
        return {"error": f"routing-weight compute failed: {e}"}

    per_clip: dict[tuple, dict] = {}
    try:
        with ThreadPoolExecutor(max_workers=3) as ex:
            futures = {
                m: ex.submit(_query_one_modality, query_vec, knowledge_store_id, m, ROUTING_PER_MOD_K)
                for m in ("visual", "audio", "transcription")
            }
            for modality, fut in futures.items():
                resp = fut.result()
                for v in resp.get("vectors") or []:
                    md = v.get("metadata") or {}
                    asset_id = md.get("asset_id") or md.get("mimir_id")
                    start = md.get("start_sec") or 0
                    end = md.get("end_sec") or 0
                    if not asset_id:
                        continue
                    similarity = 1.0 - float(v.get("distance") or 0.0)
                    key = (asset_id, int(start), int(end))
                    entry = per_clip.setdefault(key, {
                        "asset_id": asset_id, "start_sec": int(start), "end_sec": int(end),
                        "contrib": {"visual": 0.0, "audio": 0.0, "transcription": 0.0},
                    })
                    entry["contrib"][modality] = max(entry["contrib"][modality], similarity)
    except Exception as e:
        return {"error": f"S3 Vectors query failed: {e}"}

    fused = []
    for entry in per_clip.values():
        c = entry["contrib"]
        score = (
            weights["visual"] * c["visual"]
            + weights["audio"] * c["audio"]
            + weights["transcription"] * c["transcription"]
        )
        dominant = max(c.items(), key=lambda kv: weights[kv[0]] * kv[1])[0]
        fused.append({**entry, "score": score, "dominant_modality": dominant})
    fused.sort(key=lambda r: r["score"], reverse=True)

    # Drop candidates whose [start_sec, end_sec] overlaps a known
    # skip_range on their asset (credits, studio logo, fade-to-black, title
    # card, color bars). These come from the per-asset Pegasus profile in
    # kb_cache (ASSET# rows, populated by lambda/asset_profile). Assets that
    # haven't been re-profiled yet have no skip_ranges and pass through —
    # the no-black-frame-start prompt rule still applies in that case.
    fused = _drop_skip_overlaps(fused, knowledge_store_id, target_count=k)

    clips = []
    for i, r in enumerate(fused[:k]):
        clips.append({
            "asset_id":          r["asset_id"],
            "start_time":        _secs_to_hhmmss(r["start_sec"]),
            "end_time":          _secs_to_hhmmss(r["end_sec"]),
            "rank":              i + 1,
            "score":             round(r["score"], 4),
            "distance":          round(1.0 - r["score"], 4),
            "dominant_modality": r["dominant_modality"],
        })
    return {
        "clips":           clips,
        "query":           query_text,
        "routing_weights": {m: round(w, 3) for m, w in weights.items()},
    }


# ═══ Tier 1: Cache (DDB · sub-10ms) ═══════════════════════════════════════════
# Caches the mini-ontology / content-profile layer used by the agent.
# Populated by scripts/ingest-kb-cache.py — one Pegasus call per asset at
# ingestion time, then sub-10ms reads here at every query turn.

@tool
def get_kb_overview(knowledge_store_id: str) -> dict:
    """Return the pre-computed corpus overview for a knowledge store: total
    asset count, dominant moods, visual styles, common roles, and sample
    titles. **Call this FIRST on any new knowledge store** — costs nothing
    (single DDB GetItem) and tells you what's in the corpus without spending
    a Marengo or Pegasus call. If `cached=False`, fall through to
    `vector_search` and `pegasus_analyze`.

    Args:
        knowledge_store_id: TL knowledge-store id (form: ks_xxxxxxxx).

    Returns:
        {cached, asset_count, top_moods, top_styles, top_roles, sample_titles,
        marengo_index_id, marengo_index_name, marengo_video_count}.
    """
    if not knowledge_store_id:
        return {"cached": False, "error": "knowledge_store_id required"}
    item = _ddb_kb_get(f"ks#{knowledge_store_id}", "OVERVIEW")
    if not item:
        return {"cached": False, "knowledge_store_id": knowledge_store_id}
    return {
        "cached":              True,
        "asset_count":         item.get("asset_count"),
        "top_moods":           item.get("top_moods") or [],
        "top_styles":          item.get("top_styles") or [],
        "top_roles":           item.get("top_roles") or [],
        "sample_titles":       item.get("sample_titles") or [],
        "marengo_index_id":    item.get("marengo_index_id"),
        "marengo_index_name":  item.get("marengo_index_name"),
        "marengo_video_count": item.get("marengo_video_count"),
    }


@tool
def list_kb_assets(
    knowledge_store_id: str,
    mood: Optional[str] = None,
    role: Optional[str] = None,
    limit: int = 30,
) -> list:
    """List assets in a knowledge store from the pre-built cache, optionally
    filtered by mood or role. **Cache-first path — prefer this over
    vector_search when the goal is "find me clips that fit a mood or role"**
    (tension, action, coda, landscape, intimacy). DDB-fast (single-digit ms)
    vs. retrieval's 200-400ms.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        mood: optional case-insensitive partial match against mood_tags.
        role: optional case-insensitive partial match against role_hint.
        limit: max assets (default 30).

    Returns:
        List of profiles: {asset_id, title, one_liner, mood_tags,
        primary_subjects, visual_style, role_hint}.
    """
    if not knowledge_store_id:
        return [{"error": "knowledge_store_id required"}]
    raw = _ddb_kb_query(f"ks#{knowledge_store_id}", "ASSET#", limit=None)
    out: list = []
    mood_l = (mood or "").lower().strip() or None
    role_l = (role or "").lower().strip() or None
    for r in raw:
        if mood_l:
            tags = [str(m).lower() for m in (r.get("mood_tags") or [])]
            if not any(mood_l in t for t in tags):
                continue
        if role_l:
            rh = str(r.get("role_hint") or "").lower()
            if role_l not in rh:
                continue
        out.append({
            "asset_id":         r.get("asset_id"),
            "title":            r.get("title"),
            "one_liner":        r.get("one_liner"),
            "mood_tags":        r.get("mood_tags") or [],
            "primary_subjects": r.get("primary_subjects") or [],
            "visual_style":     r.get("visual_style"),
            "role_hint":        r.get("role_hint"),
        })
        if len(out) >= limit:
            break
    return out


@tool
def list_kb_events(knowledge_store_id: str, limit: int = 20) -> list:
    """List multi-clip events clustered from the KB at ingest time. An event
    is a set of ≥2 clips that are both visually similar AND share at least
    one mood tag or primary subject. Cross-asset events live in a single
    DDB Query. **Use this when the user asks "what
    happens across multiple clips" or "find the sequence about X"** — it's
    sub-10ms (DDB Query) and surfaces cross-asset structure the per-asset
    list_kb_assets tool can't.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        limit: max events (default 20).

    Returns:
        List of {event_id, description, participating_assets[], mood_signature[],
        primary_subjects[], cluster_size, confidence}. Sorted by cluster_size
        descending. Empty list if no events have been clustered yet — run
        `scripts/build_event_groups.py <ks_id>` to populate.
    """
    if not knowledge_store_id:
        return [{"error": "knowledge_store_id required"}]
    raw = _ddb_kb_query(f"ks#{knowledge_store_id}", "EVENT#", limit=None)
    rows = []
    for r in raw:
        rows.append({
            "event_id":             r.get("event_id"),
            "description":          r.get("description"),
            "participating_assets": r.get("participating_assets") or [],
            "mood_signature":       r.get("mood_signature") or [],
            "primary_subjects":     r.get("primary_subjects") or [],
            "cluster_size":         r.get("cluster_size") or 0,
            "confidence":           r.get("confidence") or 0.0,
        })
    rows.sort(key=lambda e: (e["cluster_size"], e["confidence"]), reverse=True)
    return rows[:limit]


@tool
def lookup_event(knowledge_store_id: str, event_id: str) -> dict:
    """Read one cached event (multi-clip cluster) by id. Returns the full
    record including every participating asset_id, the shared mood/subject
    signature, and a one-line description of what the event collectively
    depicts.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        event_id: evt_xxxxxxxxxxxx — from list_kb_events.

    Returns:
        {found, event_id, description, participating_assets[], mood_signature[],
        primary_subjects[], cluster_size, confidence}.
    """
    if not knowledge_store_id or not event_id:
        return {"found": False, "error": "knowledge_store_id and event_id required"}
    item = _ddb_kb_get(f"ks#{knowledge_store_id}", f"EVENT#{event_id}")
    if not item:
        return {"found": False, "event_id": event_id}
    return {
        "found":                True,
        "event_id":             item.get("event_id"),
        "description":          item.get("description"),
        "participating_assets": item.get("participating_assets") or [],
        "mood_signature":       item.get("mood_signature") or [],
        "primary_subjects":     item.get("primary_subjects") or [],
        "cluster_size":         item.get("cluster_size") or 0,
        "confidence":           item.get("confidence") or 0.0,
    }


@tool
def find_cached_entity_appearances(knowledge_store_id: str, entity_name: str) -> dict:
    """Look up which assets a named entity appears in, from the kb_cache
    cross-asset entity graph. Single DDB GetItem. Prefer this whenever the
    user names a person/object/place that was profiled at ingest time.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        entity_name: any reasonable spelling of the entity. Match is
            case-insensitive and whitespace-collapsed.

    Returns:
        {found, name, kind, asset_ids[], appearance_count, aliases[]}.
        found=False → cache miss; fall through to vector_search.
    """
    if not knowledge_store_id or not entity_name:
        return {"found": False, "error": "knowledge_store_id and entity_name required"}
    canonical = " ".join(entity_name.lower().split())
    item = _ddb_kb_get(f"ks#{knowledge_store_id}", f"ENTITY#{canonical}")
    if not item:
        return {"found": False, "entity_name": entity_name, "canonical": canonical}
    return {
        "found":            True,
        "name":             item.get("name"),
        "canonical":        item.get("canonical"),
        "kind":             item.get("kind"),
        "asset_ids":        item.get("asset_ids") or [],
        "appearance_count": item.get("appearance_count") or 0,
        "aliases":          item.get("aliases") or [],
    }


@tool
def list_cached_entities(
    knowledge_store_id: str,
    kind: Optional[str] = None,
    limit: int = 30,
) -> list:
    """List entities extracted into the kb_cache entity graph, optionally
    filtered by kind (person, object, place, brand, animal). Sorted by
    appearance count (most-cited first). Use this when the user asks
    "who appears in this KB" or before deciding which entities to track.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        kind: optional case-insensitive filter (person, object, place, brand, animal).
        limit: max entities (default 30).

    Returns:
        List of {name, canonical, kind, asset_ids[], appearance_count, aliases[]}.
    """
    if not knowledge_store_id:
        return [{"error": "knowledge_store_id required"}]
    raw = _ddb_kb_query(f"ks#{knowledge_store_id}", "ENTITY#", limit=None)
    kind_l = (kind or "").lower().strip() or None
    rows = []
    for r in raw:
        if kind_l and str(r.get("kind") or "").lower() != kind_l:
            continue
        rows.append({
            "name":             r.get("name"),
            "canonical":        r.get("canonical"),
            "kind":             r.get("kind"),
            "asset_ids":        r.get("asset_ids") or [],
            "appearance_count": r.get("appearance_count") or 0,
            "aliases":          r.get("aliases") or [],
        })
    rows.sort(key=lambda r: r["appearance_count"], reverse=True)
    return rows[:limit]


@tool
def lookup_asset_profile(knowledge_store_id: str, asset_id: str) -> dict:
    """Read the cached profile for one asset (title, one-liner, mood tags,
    subjects, visual style, role). **Use before pegasus_analyze** — if the
    cached one_liner answers your question, skip the Pegasus call.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        asset_id: 24-char hex asset id.

    Returns:
        {cached, asset_id, title, one_liner, mood_tags, primary_subjects,
        visual_style, role_hint}. cached=False → consider pegasus_analyze.
    """
    if not knowledge_store_id or not asset_id:
        return {"cached": False, "error": "knowledge_store_id and asset_id required"}
    item = _ddb_kb_get(f"ks#{knowledge_store_id}", f"ASSET#{asset_id}")
    if not item:
        return {"cached": False, "asset_id": asset_id}
    return {
        "cached":           True,
        "asset_id":         asset_id,
        "title":            item.get("title"),
        "one_liner":        item.get("one_liner"),
        "mood_tags":        item.get("mood_tags") or [],
        "primary_subjects": item.get("primary_subjects") or [],
        "visual_style":     item.get("visual_style"),
        "role_hint":        item.get("role_hint"),
    }


# ═══ Tier 2: Live grounding via Bedrock Pegasus ═══════════════════════════════

@tool
def pegasus_analyze(
    target: str,
    prompt: str,
    target_type: str = "asset_id",
    max_tokens: int = 1024,
    temperature: float = 0.2,
) -> str:
    """Generate a take-note about a specific clip using Bedrock Pegasus 1.2.
    Use when the producer asks what a clip visibly contains (subject, action,
    framing, mood, dialogue) — questions a similarity score cannot answer.
    **Check lookup_asset_profile first** — the cached one_liner often suffices.

    Reads s3://CLIPS_BUCKET_NAME/clips/<asset_id>.mp4 directly with the
    runtime's IAM role; no media leaves the customer account.

    Args:
        target: asset_id (24-hex).
        prompt: instruction for Pegasus.
        target_type: kept for backward compat; only "asset_id" is supported.
        max_tokens: response cap (unused on the Bedrock path).
        temperature: sampling temperature.

    Returns:
        Pegasus's grounded text response.
    """
    if not target:
        return "error: target asset_id is required"
    if not prompt:
        return "error: prompt is required"
    if target_type != "asset_id":
        return "error: only target_type='asset_id' is supported in the AWS-native build"
    return _pegasus_bedrock(target, prompt, temperature)


def _pegasus_bedrock(asset_id: str, prompt: str, temperature: float) -> str:
    if not CLIPS_BUCKET_NAME or not CLIPS_BUCKET_OWNER:
        return "error: CLIPS_BUCKET_NAME / CLIPS_BUCKET_OWNER not configured (falling back to tl_api)"
    body = {
        "inputPrompt": prompt,
        "mediaSource": {
            "s3Location": {
                "uri": f"s3://{CLIPS_BUCKET_NAME}/clips/{asset_id}.mp4",
                "bucketOwner": CLIPS_BUCKET_OWNER,
            }
        },
        "temperature": temperature,
    }
    try:
        resp = _bedrock_rt.invoke_model(
            modelId=PEGASUS_BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(resp["body"].read())
    except Exception as e:
        return f"pegasus (bedrock) failed: {e}"
    return payload.get("message") or "(no text returned)"


# ═══ Phase 3: Image-grounded entity recognition via Titan + S3 Vectors ════════
# Image-grounded entity_reid path. Reference (Postgres-backed) flow:
#   gdino → DeepSORT → Re-ID features → Postgres entity registry (index time)
#   entity_id lookup → asset_ids (query time, O(1))
#
# This implementation, on AWS-managed services:
#   Bedrock Titan Multimodal Embeddings (amazon.titan-embed-image-v1)
#     → S3 Vectors index (entity_thumbs) (index time)
#   Reference image → Titan embed → S3 Vectors ANN → asset_ids (query time, O(log N))
#
# Trade-off vs. proper Re-ID: no detection step. We embed whole frames,
# not detected face/object patches. Strong for "find clips that look like
# this scene"; weaker for "find this specific person" where a face crop
# would dominate the embedding. The detection layer is what proper Phase
# 3 (SageMaker gdino + DeepSORT) would add later.

TITAN_IMAGE_EMBED_MODEL_ID = os.environ.get(
    "TITAN_IMAGE_EMBED_MODEL_ID",
    "amazon.titan-embed-image-v1",
)
VECTOR_INDEX_ENTITY_THUMBS = os.environ.get("VECTOR_INDEX_ENTITY_THUMBS", "entity-thumbs")


def _titan_embed_image(image_bytes: bytes) -> list[float]:
    """Embed a single image via Bedrock Titan Multimodal Embeddings.
    Returns a 1024-dim float vector in the same space as the indexed
    entity-thumbnail embeddings."""
    import base64
    b64 = base64.b64encode(image_bytes).decode("ascii")
    body = {
        "inputImage": b64,
        "embeddingConfig": {"outputEmbeddingLength": 1024},
    }
    resp = _bedrock_rt.invoke_model(
        modelId=TITAN_IMAGE_EMBED_MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
    )
    payload = json.loads(resp["body"].read())
    v = payload.get("embedding") or []
    if not v:
        raise RuntimeError(f"Titan returned no embedding: {json.dumps(payload)[:300]}")
    return v


def _fetch_image_bytes(url: str) -> bytes:
    """Resolve a reference image URL to bytes. Accepts:
      - s3://bucket/key
      - https:// or http:// — fetched via httpx
    """
    if url.startswith("s3://"):
        rest = url[len("s3://"):]
        bucket, _, key = rest.partition("/")
        if not (bucket and key):
            raise ValueError(f"malformed s3 url: {url}")
        s3 = boto3.client("s3", region_name=AWS_REGION)
        obj = s3.get_object(Bucket=bucket, Key=key)
        return obj["Body"].read()
    if url.startswith("http://") or url.startswith("https://"):
        with httpx.Client(timeout=60, follow_redirects=True) as c:
            r = c.get(url)
        r.raise_for_status()
        return r.content
    raise ValueError(f"unsupported reference_url scheme: {url[:40]}")


@tool
def find_entity_by_image(
    knowledge_store_id: str,
    reference_url: str,
    k: int = 10,
) -> dict:
    """**AWS-native Re-ID-style search**. Given a reference image (s3:// or
    https://), find clips in the knowledge store whose representative
    frames are most visually similar. Uses Bedrock Titan Multimodal
    Embeddings + S3 Vectors — single image embed call plus an O(log N)
    ANN lookup against the per-KS entity-thumbnail / entity-patches index.

    Requires the index to have been populated at ingest time by
    `scripts/ingest_entity_thumbs.py` or the entity Re-ID Step Functions
    pipeline (see `infra/step-functions.tf`).

    Args:
        knowledge_store_id: ks_xxxxxxxx — used as a metadata filter on
            the S3 Vectors query.
        reference_url: s3://bucket/key OR https://... pointing at the
            reference image (jpeg/png). A frame crop of the entity to find.
        k: how many distinct asset matches to return (default 10).

    Returns:
        {matches: [{asset_id, score, best_frame_pct, frame_url?}], scanned,
        index_name}. Sorted by score descending. score is 1 - distance
        (cosine), higher = more visually similar.
    """
    if not knowledge_store_id or not reference_url:
        return {"error": "knowledge_store_id and reference_url required"}
    if not VECTOR_BUCKET_NAME:
        return {"error": "VECTOR_BUCKET_NAME not configured"}

    try:
        img = _fetch_image_bytes(reference_url)
    except Exception as e:
        return {"error": f"image fetch failed: {e}"}
    try:
        qvec = _titan_embed_image(img)
    except Exception as e:
        return {"error": f"Titan embed failed: {e}"}

    # Over-fetch so that grouping-by-asset still yields k distinct assets
    # even when multiple frames of the same clip score highly.
    over_k = max(k * 4, 20)
    try:
        resp = _s3v.query_vectors(
            vectorBucketName=VECTOR_BUCKET_NAME,
            indexName=VECTOR_INDEX_ENTITY_THUMBS,
            topK=over_k,
            queryVector={"float32": qvec},
            filter={"knowledge_store_id": knowledge_store_id},
            returnDistance=True,
            returnMetadata=True,
        )
    except Exception as e:
        return {"error": f"S3 Vectors query failed: {e}"}

    # Group hits by asset_id, keep the best-scoring frame per asset.
    best_by_asset: dict[str, dict] = {}
    for v in resp.get("vectors") or []:
        md = v.get("metadata") or {}
        aid = md.get("asset_id")
        if not aid:
            continue
        sim = 1.0 - float(v.get("distance") or 0.0)
        entry = best_by_asset.get(aid)
        if entry is None or sim > entry["score"]:
            best_by_asset[aid] = {
                "asset_id":       aid,
                "score":          sim,
                "best_frame_pct": md.get("frame_pct"),
                "frame_s3_uri":   md.get("frame_s3_uri"),
            }

    matches = sorted(best_by_asset.values(), key=lambda r: r["score"], reverse=True)[:k]
    for m in matches:
        m["score"] = round(m["score"], 4)
    return {
        "matches":    matches,
        "scanned":    len(resp.get("vectors") or []),
        "index_name": VECTOR_INDEX_ENTITY_THUMBS,
    }


# ═══ Ancillary: Domain DDB lookups ════════════════════════════════════════════

@tool
def lookup_rights(asset_id: str, region: Optional[str] = None) -> dict:
    """Fetch licensing and clearance information for a video asset from the
    rights system. Use whenever the user asks about usage rights, territory
    (US, EMEA, APAC), license windows or expiry, talent/music clearance, or
    "can we use this".

    Args:
        asset_id: TL asset id resolved via prior tools — never guess.
        region: optional region filter (US, EMEA, APAC, GLOBAL).

    Returns:
        {found, title, rights: [windows], talent_clearances}.
    """
    if not RIGHTS_TABLE:
        return {"error": "RIGHTS_TABLE env var not set"}
    r = _ddb.get_item(TableName=RIGHTS_TABLE, Key={"asset_id": {"S": asset_id}})
    item = _ddb_to_python(r.get("Item"))
    if not item:
        return {
            "asset_id": asset_id,
            "found": False,
            "message": "No rights record on file. Treat as 'unknown — verify with rights management before use.'",
        }
    rights = item.get("rights", []) or []
    if region:
        r_up = region.upper()
        rights = [w for w in rights if (w.get("region") or "").upper() == r_up or w.get("region") == "GLOBAL"]
    return {
        "asset_id":          asset_id,
        "found":             True,
        "title":             item.get("title"),
        "rights":            rights,
        "talent_clearances": item.get("talent_clearances") or [],
    }


@tool
def list_audiences() -> list:
    """List audience-intelligence segments (demographics + content affinity).
    Use when the user asks for a channel for a specific audience ("Men 25-54",
    "young women", "sports fans") to discover what segments exist BEFORE
    committing to a name.

    Returns:
        List of {segment_id, name, description, demographics, size_estimate}.
        Pair with lookup_audience for the full affinity profile.
    """
    if not AUDIENCES_TABLE:
        return [{"error": "AUDIENCES_TABLE env var not set"}]
    r = _ddb.scan(TableName=AUDIENCES_TABLE)
    out = []
    for item in r.get("Items", []):
        py = _ddb_to_python(item)
        if not py:
            continue
        out.append({
            "segment_id":    py.get("segment_id"),
            "name":          py.get("name"),
            "description":   py.get("description"),
            "demographics":  py.get("demographics"),
            "size_estimate": py.get("size_estimate"),
        })
    return out


@tool
def lookup_audience(segment_id: str) -> dict:
    """Fetch the full audience profile for a segment — demographics, genre
    affinity (index >1.0 = over-indexed vs. general pop), daypart preferences.
    Use when programming a channel for a known audience: skew genre mix
    toward indexes >1.0 in this segment.

    Args:
        segment_id: discover via list_audiences().

    Returns:
        Full segment record: name, description, demographics, genre_affinity,
        daypart_affinity, size_estimate, notes.
    """
    if not AUDIENCES_TABLE:
        return {"error": "AUDIENCES_TABLE env var not set"}
    r = _ddb.get_item(TableName=AUDIENCES_TABLE, Key={"segment_id": {"S": segment_id}})
    item = _ddb_to_python(r.get("Item"))
    if not item:
        return {"segment_id": segment_id, "found": False, "message": "No audience segment with that id."}
    return {**item, "found": True}


# ═══ System prompt ════════════════════════════════════════════════════════════
SYSTEM_PROMPT = """You are a senior content operations assistant for a media organization, built on AWS Bedrock AgentCore. The deployment is fully AWS-native — every model you reach (Marengo, Pegasus, Titan, Claude) runs through Bedrock; every store (DynamoDB kb_cache, S3 Vectors, S3 clips bucket) lives inside the customer account. There is no TwelveLabs SaaS dependency on the live path.

The active `knowledge_store_id` is provided in the user message metadata as `[ks: ks_xxx]`. If it isn't there, ask the user to select a knowledge base before proceeding.

# Tools by speed class — ALWAYS try the fastest path first

## Tier 0 — AWS-native retrieval (S3 Vectors · 200–400 ms)

1. **vector_search(query_text, knowledge_store_id?, k=5)** — multi-modal retrieval over S3 Vectors. Embeds the query via Bedrock-hosted Marengo and runs three parallel ANN queries (visual / audio / transcription), softmax-fused. Returns asset_id + HH:MM:SS timecodes + per-modality score breakdown.
2. **find_entity_by_image(knowledge_store_id, reference_url, k?)** — image-grounded recognition. Given a reference image URL (s3:// or https://), runs Bedrock Titan Multimodal Embeddings on it and does an S3 Vectors ANN against a per-KS entity-thumbnail (or entity-patches) index populated at ingest. Returns ranked asset_ids. Use when the user provides or names an image they want to match.

## Tier 1 — Cache (DynamoDB · sub-10 ms). **Always start here on a known knowledge_store_id.**

1. **get_kb_overview(knowledge_store_id)** — corpus summary: asset count, dominant moods, visual styles, role distribution, sample titles, entity count. Call this FIRST on any new KS.
2. **list_kb_assets(knowledge_store_id, mood?, role?)** — filtered list of pre-profiled assets with title, one-liner, mood tags, subjects. The right tool for "find me clips that fit a tone/role".
3. **lookup_asset_profile(knowledge_store_id, asset_id)** — single-asset cached digest. Often replaces a pegasus_analyze.
4. **find_cached_entity_appearances(knowledge_store_id, entity_name)** — returns asset_ids where a named entity appears, from the kb_cache cross-asset entity graph. Use whenever the user names a person/object/place. Single DDB GetItem.
5. **list_cached_entities(knowledge_store_id, kind?)** — top entities extracted at ingest, sorted by appearance count.
6. **list_kb_events(knowledge_store_id)** — multi-clip events clustered by Claude at ingest. Use for "what storyline spans these clips".
7. **lookup_event(knowledge_store_id, event_id)** — full record for one event with every participating asset_id.

If the cache returns `cached: False` or no matches, fall through to Tier 2.

## Tier 2 — On-demand grounding (Bedrock Pegasus 1.2 · 3–15 s)

1. **pegasus_analyze(target, prompt)** — single-clip generation. Reads `s3://CLIPS_BUCKET_NAME/clips/<asset_id>.mp4` directly with the runtime's IAM role. Use ONLY when cached `lookup_asset_profile` doesn't suffice — "what's visibly happening here", "is this shot bright enough", "what's being said".

## Ancillary stores (DDB)

1. **lookup_rights(asset_id, region?)** — DDB licensing record.
2. **list_audiences()** / **lookup_audience(segment_id)** — DDB audience intelligence (genre + daypart affinity).

# Speed playbook

For a multi-clip rough cut / channel build:
1. `get_kb_overview` (cheap, instant) — see what moods/roles exist.
2. **In a single turn, emit parallel `list_kb_assets` calls** — one per beat (tension, action, coda). Tool calls fan out concurrently.
3. Pick clips from the cached candidates by `one_liner` + `mood_tags`.
4. Only hit `vector_search` when you need fine timecodes inside an asset, or when no cached asset matches a beat.
5. Only hit `pegasus_analyze` when the cached `one_liner` is missing or insufficient.

For a single-asset rights/clearance question:
1. `lookup_asset_profile` to confirm what the asset is.
2. `lookup_rights` for the licensing window. Done.

For "find every clip of person X cleared for region Y":
1. `find_cached_entity_appearances(ks_id, "<person>")` → asset_ids.
2. **Parallel `lookup_rights(asset_id, region=Y)` calls** for each candidate.
3. Return only the ones cleared for Y.

# Combining tools

- "Find a clip we can use for X in EMEA" → list_kb_assets (cached) → pick → lookup_rights (DDB). Two calls, sub-second.
- "Explain why this clip is dramatic" → lookup_asset_profile first; only call pegasus_analyze if the cached profile is missing or thin.
- "What's in this knowledge base?" → get_kb_overview (cached) is enough.

If the user names a video by description, resolve to an asset_id via list_kb_assets (cached, fast) before calling lookup_rights — never guess an asset_id. Fall through to vector_search only if the cache doesn't have it.

# When the cache is empty

If `get_kb_overview` returns `cached: False` for a ks_id, the cache hasn't been built. Tell the user:
> "This KB doesn't have its profile cache built yet — falling back to live retrieval; expect ~3-5× slower responses. (Run `scripts/ingest_kb_cache.py <ks_id>` to build it.)"
Then proceed with Tier 0 / Tier 2 tools as normal.

# Edit Decision List (Rough Cut) mode

When the user asks for a rough cut, highlight reel, or trailer-shaped sequence (signals: "build me a reel", "rough cut", "trailer", "highlight"), respond in TWO parts:

(a) One or two sentences of prose: how you decomposed the brief, how confident the top picks look.
(b) A single JSON document inside `<plan>...</plan>` tags, matching the schema below. Strict JSON: no trailing commas, no markdown fences inside the tags, no prose after the closing tag.

**Title rule.** Pick a title that names the content + cut type (e.g. "Hollywood Sizzle Reel", "Blender Open Movies — Narrative Trailer"). **Do NOT embed a specific duration number** in the title (no "45s Cut", "60-Second Sizzle", etc.). The UI shows the actual total duration alongside the title; embedding a number that doesn't match the emitted total looks wrong every time the cut doesn't hit the exact target.

```
{
  "title": str,
  "scenes": [
    {
      "scene_id": "01" | "02" | ...,
      "scene_name": str,
      "scene_description": str?,
      "clips": [
        {
          "video_reference": str,            // 24-char hex asset_id
          "start_time": "HH:MM:SS",
          "end_time":   "HH:MM:SS",
          "role": "establishing"|"wide"|"medium"|"close-up"|"insert"|"cutaway"|"b-roll"|"hero",
          "take_note": str,                  // one sentence on visible content
          "alternatives": [                  // 2-4 entries
            {"video_reference": str, "start_time": "HH:MM:SS", "end_time": "HH:MM:SS", "rank": int, "why_alt": str}
          ]
        }
      ]
    }
  ],
  "total_estimated_duration": "MM:SS",
  "notes": str
}
```

Procedure for Rough Cut:

1. `get_kb_overview` to learn what's available.

2. **Classify the cut type FIRST.** The producer's brief implies one of these — pick the closest match and apply its constraints throughout. Mention the type you picked in your one-or-two-sentence prose reply so the producer can correct you.

   | Type | Signals in the brief | Clip duration | Scene count | Total | Pacing rules |
   |---|---|---|---|---|---|
   | **sizzle reel** | "sizzle", "teaser", "showcase", "high-energy", "exciting" | 3-7 s | 5-8 | 30-60 s | Kinetic pacing, max mood diversity, **never two adjacent scenes from the same asset**, dialogue clips ≤ 2 in the whole cut |
   | **narrative trailer** | "trailer", "story", "arc", "tension to release" | 5-12 s | 4-7 | 60-120 s | Three-act emotional arc (setup → conflict → resolution). Multiple shots from the same asset OK but never consecutive |
   | **montage** | "montage", "rapid", "compilation" | 2-5 s | 8-15 | 30-90 s | Rapid cuts, one unifying theme/mood, same-asset reuse fine if not back-to-back |
   | **mood reel / B-roll** | "atmospheric", "mood", "vibe", "b-roll", "background" | 5-15 s | 4-8 | 60-180 s | Slower pacing, similar moods welcome, less variety required |
   | **highlight reel** (sports / news) | "highlights", "best moments", "plays" | per-event (typically 5-15 s) | 5-10 | 60-180 s | Each entry is one continuous event/play; don't chop within a moment |
   | **rough cut** (full documentary / short-film assembly) | "rough cut", "documentary", "doc", "short film", "feature", "full assembly", "first cut" | 10-30 s | 8-20 | 4-15 min | Long-form story assembly, not a hype reel. Open cold on a character or setting beat, then walk through narrative stages (setup → development → escalation → climax → coda). Mix interview, b-roll, atmospheric, archival as the corpus offers. Same-asset reuse is fine and expected (a doc has multiple interview takes from one subject); ONLY hard rule is no two CONSECUTIVE scenes from the same asset. Dialogue/interview clips are welcome — this is the form that needs them most. |

   If the brief doesn't match any cleanly, default to **narrative trailer**.

3. Parse the brief into N beat phrases in narrative order. N matches the "scene count" range from the cut-type table.

4. In a single turn, emit N parallel `list_kb_assets` calls (one per beat's mood). If cache misses, fall through to `vector_search` per missed beat.

5. For each beat: rank-1 cached/retrieved clip = primary. For alternates, walk ranks 2..k and pick the first candidate from each NEW asset_id; skip any candidate whose asset_id has already been used as this clip's primary or earlier alternate. Target 2-4 alternates, each from a distinct asset_id where possible. Use cached `one_liner` for the `take_note` — only call `pegasus_analyze` if missing.

6. Constraints: clip duration follows the cut-type table; total duration follows the cut-type table; time fields HH:MM:SS, no SMPTE frame suffix.

   **No-black-frame-start rule.** Producer-facing cuts must not open on a black frame or a fade-in. When you set a clip's `source_start`:
   - **Never use `0:00.0`** (or any value <0.5s into the asset) for a primary clip. Asset starts almost always include a hard cut from black, a fade-in, a slate, or a title card.
   - When `vector_search` returns a window like `[0.0, 4.5]`, treat the segment's *interior* — push the start at least 0.5–1.0s into the matched window. The window represents the embedding's matched region, not a precise IN point.
   - If the cached `lookup_asset_profile` flags an asset with `role_hint = "cold-open"` AND your beat is *not* an opening, prefer a different asset for that beat — cold-open assets are heavy with black/title at their head.
   - This rule applies to alternates too; an alternate exists to be promoted, so it must also be clean at the head.

   **Duration-target rule (HARD).** Parse the producer's brief for an explicit total-duration target ("45 seconds", "45s", "1 minute", "90 sec", "two minutes", etc.). If one is present:
   - Treat it as a HARD target. After picking primaries, sum `(source_end - source_start)` across all scenes. Compute `delta = total - target`.
   - The emitted plan's `total_estimated_duration` MUST land within `max(3s, 10% of target)` of the target. For a 45s target that's ±4.5s (i.e. 40.5–49.5s).
   - If outside the band, ITERATE before emitting:
       - **Short by Xs:** extend the longest scenes' clip durations (within the per-clip cap from the cut-type table) until the gap closes; if still short after maxing every scene's clip, add one more beat from the brief or split an existing beat.
       - **Long by Xs:** trim the lowest-rank primaries' durations first (toward the per-clip minimum from the table); if still long, drop the weakest beat entirely.
   - Re-sum after each iteration. Loop until inside the band, then emit.
   - **The prose reply's stated total MUST equal the actual sum of `(source_end - source_start)` across the scenes in the emitted `<plan>`.** Don't narrate "lands at ~42s" while emitting 7 scenes × 5s = 35s. The actual sum, computed from the timecodes you're about to emit, is the only number that counts. If your prose says one number and the plan sums to another, you have failed the rule. Recompute the sum from the FINAL emitted timecodes; do not estimate or guess.
   - **If no explicit target** in the brief, fall back to the cut-type table's "Total" range and aim for its midpoint.
   - **If the target is unreachable** (e.g. asked for 5 minutes but only 6 short alternates exist after dedup), emit the closest legal plan AND state the gap in your prose reply ("Could only hit 95s — corpus is short on clips matching beat 4 and the per-clip cap is 30s; ask me to relax a constraint to extend further"). Do NOT silently emit something wildly off-target.

7. **Global uniqueness + adjacency pass** (run AFTER all beats resolve, BEFORE emitting `<plan>`):
   a. Build a set `USED` of (asset_id, start_time, end_time) tuples for every primary across every scene, AND every alternate inside every clip.
   b. **Primary tuple dedup.** If a primary's tuple already appears for an earlier scene, promote that scene's rank-2 alternate to primary and demote the colliding clip into the alternates list. Re-check the new primary against `USED`; if it also collides, try rank-3, then rank-4, etc.
   c. **Adjacent same-asset check (HARD CONSTRAINT for sizzle/narrative/montage/highlight).** For every consecutive pair of scene primaries (scene N, scene N+1), if they share the same `asset_id` — *even at different timecodes* — you MUST resolve the collision before emitting `<plan>`. Resolution order:
       (i) Promote scene N+1's first alternate that has a DIFFERENT asset_id to primary.
       (ii) If no alternate has a different asset_id, run a fresh `vector_search` for that beat with the colliding asset_id excluded from the prompt phrase. Promote the top result.
       (iii) If retrieval still returns only the colliding asset, DROP that scene from the cut entirely (reduce the scene count by 1) rather than emit a violating plan. This is acceptable — better a 5-scene sizzle than a 6-scene one that breaks pacing.
      Re-check the chain end-to-end after each swap until no two adjacent primaries share an asset_id. **For mood reel / B-roll only**, you may keep adjacent same-asset primaries if (i)+(ii)+(iii) all fail, but you must annotate the take_note for both clips with `"reused — cross-cut needed"`.
   d. **Alternate dedup.** For each clip's alternates list, drop any alternate whose tuple equals another clip's primary anywhere in the cut. Drop any alternate whose tuple equals another alternate already kept earlier in the same scan order. If an alternate's asset_id matches its own primary's asset_id AND the same asset_id is already used as primary or alternate elsewhere in the cut, drop it too. Aim to leave 2-4 distinct, useful alternates per clip; one is acceptable; zero is acceptable if nothing legitimately distinct remains.
   e. **Asset-count target.** A sizzle / narrative / highlight reel of N scenes should use AT LEAST `ceil(N * 0.7)` distinct asset_ids across its primaries. If the cut falls under that, swap weaker primaries (lowest rank-1 scores) for alternates from unused assets.
   f. If a primary in step b cannot be deduplicated (every alternate also collides), keep the constrained primary but add a one-line note to its take_note acknowledging it (e.g. "reused from scene N — cross-cut tightly"). **Step c has no escape hatch for sizzle/narrative/montage/highlight cut types** — same-asset adjacency MUST be eliminated via (i), (ii), or (iii) before emitting.
   g. Adjacency framing collisions (different asset_ids that LOOK the same in framing) still get the rank-2 swap.
   h. **Invariant on the emitted `<plan>`**: no `(asset_id, start_time, end_time)` tuple appears in two primary slots; no tuple appears in both a primary slot and any alternates list; no tuple appears in two alternates lists; **for sizzle / narrative / montage / highlight types, no two consecutive scene primaries share an `asset_id`**.

   i. **Mandatory self-verification before emit.** Before producing `<plan>`, run three assertions explicitly:
       1. **Adjacency.** Build the sequence of primary `asset_id`s in scene order: `[scene_1.asset_id, scene_2.asset_id, …]`. For each consecutive (N, N+1) pair where the cut type is sizzle/narrative/montage/highlight, assert N.asset_id ≠ N+1.asset_id. If it fails, return to step c.
       2. **Duration target.** If the brief contained an explicit duration target, walk the emitted `<plan>` scene-by-scene and compute `actual_sum = sum((source_end - source_start) for each scene's primary)` — using the EXACT timecodes you're about to emit, not your earlier estimates. Assert `abs(actual_sum - target) ≤ max(3s, 10% of target)`. If it fails, return to step 6's duration-target loop. Then assert that `total_estimated_duration` in the plan equals `actual_sum` (MM:SS) AND that the duration number you mention in your prose reply equals `actual_sum`. These three numbers — prose-stated total, plan's `total_estimated_duration`, and the sum of scene primaries — MUST be identical. Mismatch = failure.
       3. **No-black-start.** Assert every primary's `source_start` is ≥ 0.5s into its asset. If any primary opens at or near t=0, push its start to t=0.5s (extending source_end equally so the clip duration is preserved if room exists, else trimming).
      Your prose reply must accurately reflect what's in the plan — if any assertion was bent, name the gap ("delivered 41s vs 45s requested — corpus didn't have a strong sixth beat"), don't claim the plan hits the brief when it doesn't.

On a FOLLOW-UP turn during Rough Cut (current plan embedded as `[CURRENT PLAN]\n<plan>...</plan>\n[FOLLOWUP]\n...`), classify:
- INFORMATIONAL ("what is happening in scene 2 clip 1?", "is the celebration shot bright enough?") — answer in prose, ground via `lookup_asset_profile` or `pegasus_analyze` when needed. No `<plan>` block.
- STRUCTURAL ("swap scene 2 for something more kinetic", "use rank-2 on scene 4 clip 1") — reply with prose + the FULL updated `<plan>`. Include every scene; UI replaces wholesale.
- AMBIGUOUS — ask one clarifying question in prose. Don't guess.

# Style

- Be direct. Producers are busy.
- **Never expose raw asset_ids (hex strings) in your prose reply.** The asset_id belongs ONLY inside the structured `<plan>` block, where the UI uses it to render chips, thumbnails, and player URLs. In the chat-facing prose, refer to clips by **scene number + clip name** ("scene 3", "the Impact Hit close-up", "the dialogue beat"), or by **filename** if you need to disambiguate ("the Indiana Jones cut"). A 24-hex string in chat is a leak of internal machinery — producers don't read those, and they make reasoning summaries unreadable.
- This includes self-verification narration: the adjacency / duration / no-black-start checks from step 7.i are INTERNAL reasoning. Do not echo the asset_id list back to the user. State the outcome ("adjacency check passed across all six scenes"), not the raw inputs.
- For rights: name territory + window + usage. Don't say "cleared" without scope.
- If a clearance is missing/expired, say so. Risk surface is the producer's call.
"""


# ═══ Per-deployment prompt override ═══════════════════════════════════════════
# The settings page lets an operator overwrite SYSTEM_PROMPT globally without
# rebuilding the container. We read the override row at every build_agent()
# call — `build_agent` is invoked once per AgentCore session, so a save in
# the UI takes effect on the next user turn. Falls back to the baked default
# silently if DDB is unreachable or the row is absent.
def _load_system_prompt() -> str:
    if not KB_CACHE_TABLE:
        return SYSTEM_PROMPT
    try:
        row = _ddb_kb_get("settings#prompts", "agent_system")
    except Exception as e:
        print(f"agent: prompt-override read failed, using baked default: {e}")
        return SYSTEM_PROMPT
    if row and isinstance(row.get("text"), str) and row["text"].strip():
        return row["text"]
    return SYSTEM_PROMPT


# ═══ Build the agent ══════════════════════════════════════════════════════════
def build_agent(access_token: Optional[str] = None) -> tuple[Agent, str]:
    """Construct the Strands Agent. Returns (agent, mode):
      - "mcp-gateway" — wired to AgentCore Gateway (Phase 2; not yet enabled)
      - "in-process" — direct tool calls (current path)
    """
    system_prompt = _load_system_prompt()

    mcp_url = os.environ.get("GATEWAY_MCP_URL")
    if mcp_url and access_token:
        from strands.tools.mcp import MCPClient
        from mcp.client.streamable_http import streamablehttp_client

        client = MCPClient(lambda: streamablehttp_client(
            url=mcp_url,
            headers={"Authorization": f"Bearer {access_token}"},
        ))
        client.start()
        tools = client.list_tools_sync()
        agent = Agent(system_prompt=system_prompt, model=MODEL_ID, tools=tools)
        return agent, "mcp-gateway"

    agent = Agent(
        system_prompt=system_prompt,
        model=MODEL_ID,
        tools=[
            # Tier 0 — AWS-native retrieval
            vector_search,
            find_entity_by_image,
            # Tier 1 — Cache (kb_cache: per-asset profiles + cross-asset entity graph + event clusters)
            get_kb_overview, list_kb_assets, lookup_asset_profile,
            find_cached_entity_appearances, list_cached_entities,
            list_kb_events, lookup_event,
            # Tier 2 — On-demand grounding via Bedrock Pegasus
            pegasus_analyze,
            # Ancillary domain stores (rights + audience cohorts in DDB)
            lookup_rights, list_audiences, lookup_audience,
        ],
    )
    return agent, "in-process"
