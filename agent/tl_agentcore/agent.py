"""Strands Agent — tl-agentcore (AWS-only).

The agent ships with one retrieval primitive (Marengo + S3 Vectors), a
DDB-backed knowledge cache, image-grounded entity search (Titan + S3
Vectors), and one Bedrock Pegasus grounding tool. No TwelveLabs SaaS
call is made on the live path; every model the agent reaches is invoked
through Bedrock Marketplace under the customer's IAM.

  Tier 0 — Native AWS retrieval (S3 Vectors)
    vector_search                  — Bedrock Marengo embed → S3 Vectors ANN,
                                     three modality indexes, softmax fusion.
    find_by_image                  — Rekognition Faces (primary) + Marengo
                                     S3 Vectors entity-thumbs / entity-patches.

  Tier 1 — Cache (DynamoDB · sub-10ms)
    get_kb_overview                — Per-KS digest.
    list_kb_assets                 — Cached per-asset profiles, mood/role filters.
    lookup_asset_profile /         — Single-asset cached digest.
      get_content_profile            (two names, same payload — Jockey alias.)
    list_kb_events / lookup_event  — Multi-clip event clusters.
    find_cached_entity_appearances — Entity → asset_ids from the cross-asset
                                     entity graph (no model call).
    list_cached_entities           — All cross-asset entities (by kind, etc.).

  On-demand asset registration
    add_media                      — Register a new S3-hosted asset into a KS
                                     mid-conversation (DDB only; batch ingest
                                     still needed to make it searchable).

  Mining plans (EventBridge schedule + mining-run Lambda)
    jockey_save                    — Save prompt+ks+schedule; creates DDB row
                                     and an EventBridge Schedule in one call.
    jockey_list                    — List saved plans (optionally by KS).
    jockey_run                     — Fire a plan now (sync Lambda invoke).
    jockey_list_runs               — Per-plan run history (newest first).

  Tier 2 — On-demand grounding (Bedrock Pegasus 1.5)
    pegasus_analyze                — One clip → take-note via s3Location.
                                     Supports JSON-schema structured output,
                                     reference-image bindings, and sub-clip
                                     bounds (start_time / end_time).
    pegasus_segments               — One clip → auto-segmented structured
                                     metadata (time_based_metadata mode),
                                     optionally scoped to a time window.
    zoom_in_video                  — Thin wrapper for window-focused analysis;
                                     structured dict output (start_sec,
                                     end_sec, duration_sec, text).

  Ancillary (domain DDB lookups)
    lookup_rights                  — DDB licensing record.
    list_audiences / lookup_audience — DDB audience cohorts.

The agent picks the cheapest tool that answers the question. See SYSTEM_PROMPT
for the routing playbook.
"""

from __future__ import annotations

import ast as _ast
import base64
import json
import math
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Optional

import boto3
import httpx
from strands import Agent, tool

from .aliases import aliasify_result, dealias_dict, resolve_alias
from .qa_item import (
    from_cached_row as _qa_from_cached_row,
    qa_cache_row as _qa_cache_row,
    resolve_modality as _qa_resolve_modality,
    shape_prompt as _qa_shape_prompt,
    cache_key as _qa_cache_key,
)
from .web_search import search as _web_search

# ─── Configuration via env ──────────────────────────────────────────────────
MODEL_ID = os.environ.get(
    "AGENT_MODEL_ID",
    # Sonnet 4.6 — frontier-class reasoning model on Bedrock. With kb_cache
    # pre-built, the agent finishes in fewer turns; per-turn latency stays
    # well under the demo budget.
    "us.anthropic.claude-sonnet-4-6",
)
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK_FQNAME = os.environ.get("STACK_FQNAME")
AWS_ACCOUNT_ID = os.environ.get("AWS_ACCOUNT_ID")

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
    "us.twelvelabs.pegasus-1-5-v1:0",
)
CLIPS_BUCKET_NAME = os.environ.get("CLIPS_BUCKET_NAME")
CLIPS_BUCKET_OWNER = os.environ.get("CLIPS_BUCKET_OWNER")  # account id

# DDB tables (cache + domain lookups).
KB_CACHE_TABLE = os.environ.get("KB_CACHE_TABLE")
RIGHTS_TABLE = os.environ.get("RIGHTS_TABLE")
AUDIENCES_TABLE = os.environ.get("AUDIENCES_TABLE")
# PR #4: multi-turn session scratch + per-user long-term memory.
SESSIONS_TABLE = os.environ.get("SESSIONS_TABLE")
MEMORIES_TABLE = os.environ.get("MEMORIES_TABLE")
ASSETS_TABLE = os.environ.get("ASSETS_TABLE")  # PR #8: add_media writes here

# PR #10: mining plans — jockey_save / jockey_list / jockey_run /
# jockey_list_runs. All five env vars are set by infra/runtime.tf; empty
# strings cause the matching tool to short-circuit with a clear error
# instead of attempting a doomed boto call.
JOCKEY_PLANS_TABLE               = os.environ.get("JOCKEY_PLANS_TABLE")
JOCKEY_RUNS_TABLE                = os.environ.get("JOCKEY_RUNS_TABLE")
MINING_RUN_LAMBDA_ARN            = os.environ.get("MINING_RUN_LAMBDA_ARN")
MINING_SCHEDULER_GROUP           = os.environ.get("MINING_SCHEDULER_GROUP")
MINING_SCHEDULER_TARGET_ROLE_ARN = os.environ.get("MINING_SCHEDULER_TARGET_ROLE_ARN")

# PR #11: generation tools — generate_html_app / generate_video / execute_code.
# STITCH_LAMBDA_ARN wires generate_video to the existing stitch MediaConvert
# path. The HTML generator reuses MODEL_ID (Claude Sonnet on Bedrock) via the
# existing _bedrock_rt client. execute_code is pure Python with no AWS reach.
STITCH_LAMBDA_ARN = os.environ.get("STITCH_LAMBDA_ARN")

# PR #6: durable per-user artifact store.
ARTIFACTS_TABLE = os.environ.get("ARTIFACTS_TABLE")

_s3v = boto3.client("s3vectors", region_name=AWS_REGION)
_bedrock_rt = boto3.client("bedrock-runtime", region_name=AWS_REGION)
_ddb = boto3.client("dynamodb", region_name=AWS_REGION)
_rek = boto3.client("rekognition", region_name=AWS_REGION)
_s3 = boto3.client("s3", region_name=AWS_REGION)
_scheduler = boto3.client("scheduler", region_name=AWS_REGION)
_lambda = boto3.client("lambda", region_name=AWS_REGION)


def _secs_to_hhmmss(s) -> str:
    try:
        s = float(s)
    except Exception:
        return "00:00:00"
    total = max(0, int(round(s)))
    h, rem = divmod(total, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ═══ Selections: per-turn working set (Jockey parity, PR #8) ═════════════════
# The browser can attach a `selections` list to each WS turn: the clips (and
# optional time windows) the user is currently focused on in the UI. The
# runtime calls set_selections_from_payload() at turn start to stash the
# normalized list on this ContextVar; content-domain tools (pegasus_analyze,
# zoom_in_video, lookup_asset_profile, etc.) read it via _current_selections()
# to default their asset_id / start / end / knowledge_store_id args when the
# caller didn't pass them. Explicit tool-call args always win over selections.
#
# Shape (normalized, after set_selections_from_payload):
#   [{"asset_id": "<24-hex>",
#     "start_sec": 15.0?,
#     "end_sec":   30.0?,
#     "knowledge_store_id": "ks_..."?}]
#
# Entries missing asset_id are dropped. All numeric fields are coerced to
# float. Called with None or [] clears the ContextVar for this turn.

_selections_var: ContextVar[Optional[list]] = ContextVar(
    "tl_agentcore_selections", default=None,
)


def set_selections_from_payload(selections) -> list:
    normalized: list = []
    if isinstance(selections, list):
        for s in selections:
            if not isinstance(s, dict):
                continue
            aid = s.get("asset_id")
            if not aid:
                continue
            entry: dict = {"asset_id": str(aid)}
            for k in ("start_sec", "end_sec"):
                v = s.get(k)
                if v is None:
                    continue
                try:
                    entry[k] = float(v)
                except (TypeError, ValueError):
                    pass
            ks = s.get("knowledge_store_id")
            if ks:
                entry["knowledge_store_id"] = str(ks)
            normalized.append(entry)
    _selections_var.set(normalized)
    return normalized


def _current_selections() -> list:
    return _selections_var.get() or []


def _sel_default(key: str, current):
    """If `current` is None/empty, pull the same key from selections[0].

    Also expands any `@id_N` handle the agent passed in `asset_id` to the
    real 24-hex id. This is a no-op when `current` doesn't look like an
    alias. See aliases.py for the handle contract."""
    if current is not None and current != "":
        if key == "asset_id":
            current = resolve_alias(current)
        return current
    sel = _current_selections()
    if not sel:
        return current
    val = sel[0].get(key, current)
    if key == "asset_id":
        val = resolve_alias(val)
    return val


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
    # Default ks scope from the user's current selection when the agent
    # didn't explicitly pass one (Jockey "selections" semantics, PR #8).
    knowledge_store_id = _sel_default("knowledge_store_id", knowledge_store_id)
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
    return aliasify_result({
        "clips":           clips,
        "query":           query_text,
        "routing_weights": {m: round(w, 3) for m, w in weights.items()},
    })


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
    return aliasify_result(out)


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
    return aliasify_result({
        "found":            True,
        "name":             item.get("name"),
        "canonical":        item.get("canonical"),
        "kind":             item.get("kind"),
        "asset_ids":        item.get("asset_ids") or [],
        "appearance_count": item.get("appearance_count") or 0,
        "aliases":          item.get("aliases") or [],
    })


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
    return aliasify_result(rows[:limit])


def _asset_profile_dict(knowledge_store_id: str, asset_id: str) -> dict:
    """Shared body for lookup_asset_profile / get_content_profile."""
    knowledge_store_id = _sel_default("knowledge_store_id", knowledge_store_id)
    asset_id = resolve_alias(_sel_default("asset_id", asset_id))
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


@tool
def lookup_asset_profile(knowledge_store_id: str, asset_id: str) -> dict:
    """Read the cached profile for one asset (title, one-liner, mood tags,
    subjects, visual style, role). **Use before pegasus_analyze** — if the
    cached one_liner answers your question, skip the Pegasus call.

    (Alias: `get_content_profile` — same payload, Jockey-canonical name.)

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        asset_id: 24-char hex asset id.

    Returns:
        {cached, asset_id, title, one_liner, mood_tags, primary_subjects,
        visual_style, role_hint}. cached=False → consider pegasus_analyze.
    """
    return _asset_profile_dict(knowledge_store_id, asset_id)


@tool
def get_content_profile(knowledge_store_id: str, asset_id: str) -> dict:
    """Per-asset content-profile lookup from kb_cache (Jockey-canonical name).

    Same cached digest as `lookup_asset_profile`: pre-computed title, one-liner,
    mood tags, primary subjects, visual style, and role hint. **Prefer this
    over `pegasus_analyze` when a cached one-liner answers the question** —
    single DynamoDB GetItem, sub-10ms when the KS has been ingested.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        asset_id: 24-char hex asset id.

    Returns:
        {cached, asset_id, title, one_liner, mood_tags, primary_subjects,
        visual_style, role_hint}. cached=False → the asset isn't in kb_cache
        yet; fall back to `pegasus_analyze` or `vector_search`.
    """
    return _asset_profile_dict(knowledge_store_id, asset_id)


# ═══ add_media: on-demand asset registration (PR #8) ═════════════════════════

def _parse_s3_uri(uri: str) -> tuple[str, str]:
    """Return (bucket, key) for an s3:// URI, or ("", "") if malformed."""
    if not uri.startswith("s3://"):
        return "", ""
    rest = uri[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return (bucket, key) if (bucket and key) else ("", "")


@tool
def add_media(
    source: str,
    knowledge_store_id: str,
    title: Optional[str] = None,
) -> dict:
    """Register a new asset into a knowledge store, mid-conversation.

    Writes a row to the `assets` DDB table so the asset_id becomes a
    first-class citizen of this KS. **This is register-only** — vectors are
    not embedded and the kb_cache per-asset profile is not built. For the
    asset to become searchable through `vector_search` and
    `lookup_asset_profile`, the operator still runs the offline batch:
    `scripts/ingest_vectors.py <ks_id>` + `scripts/ingest-kb-cache.py <ks_id>`.
    Pegasus tools (`pegasus_analyze`, `zoom_in_video`, `pegasus_segments`)
    work immediately against the asset_id because they read bytes from
    `s3://CLIPS_BUCKET_NAME/clips/<asset_id>.mp4` directly — but that path
    must already exist (either the operator uploaded the mp4 at that key, or
    `source` points to it).

    Args:
        source: `s3://<bucket>/<key>` URI of the video object. The runtime
            must be able to `s3:GetObject` on this URI (same clips bucket, or
            a cross-account bucket whose policy allows this account to read).
            Non-S3 schemes are deferred.
        knowledge_store_id: the KS this asset joins (ks_...).
        title: optional human-readable name shown in the UI.

    Returns:
        {asset_id, knowledge_store_id, source, title, status, created_at, note}
        on success, or {"error": "..."} on failure.
    """
    if not source:
        return {"error": "source is required (s3://bucket/key)"}
    if not knowledge_store_id:
        return {"error": "knowledge_store_id is required"}
    if not ASSETS_TABLE:
        return {"error": "ASSETS_TABLE env var not set on the runtime"}
    bucket, key = _parse_s3_uri(source)
    if not bucket:
        return {"error": f"source must be an s3:// URI (got {source!r})"}
    try:
        _s3.head_object(Bucket=bucket, Key=key)
    except Exception as e:
        return {"error": f"cannot read {source}: {e}"}
    asset_id = uuid.uuid4().hex[:24]
    created_at = _utcnow_iso()
    item: dict = {
        "asset_id":           {"S": asset_id},
        "knowledge_store_id": {"S": knowledge_store_id},
        "created_at":         {"S": created_at},
        "source":             {"S": source},
        "status":             {"S": "registered"},
    }
    if title:
        item["title"] = {"S": title}
    try:
        _ddb.put_item(TableName=ASSETS_TABLE, Item=item)
    except Exception as e:
        return {"error": f"ddb put_item failed: {e}"}
    return {
        "asset_id":           asset_id,
        "knowledge_store_id": knowledge_store_id,
        "source":             source,
        "title":              title,
        "status":             "registered",
        "created_at":         created_at,
        "note": (
            "Registered. Pegasus tools work immediately against "
            "s3://CLIPS_BUCKET/clips/<asset_id>.mp4; vector_search and "
            "lookup_asset_profile require the offline batch ingest to run."
        ),
    }


# ═══ Mining plans (PR #10): jockey_save / list / run / list_runs ═════════════
#
# A "plan" is a saved prompt + ks that runs on an EventBridge schedule. The
# mining-run Lambda does the actual work; these tools own the plan rows,
# the EventBridge Schedules, and the Lambda invoke.
#
# Plans are KS-scoped, NOT user-scoped (user_id ContextVar lands with PR
# #16; follow-up adds a by-user GSI + filtering).
#
# Schedule-expression validation is deliberately lenient: EventBridge
# accepts `rate(N unit)` and `cron(...)` syntaxes with distinct rules. We
# reject only empty/missing values here and let CreateSchedule produce the
# authoritative error on malformed inputs.

_JOCKEY_MAX_LIST = 100
_JOCKEY_RUN_WAIT_SECS = 180  # cap jockey_run(wait=True) at 3 min of poll


def _jockey_schedule_name(plan_id: str) -> str:
    """Deterministic Schedule name derived from plan_id, so delete/update
    don't need an extra Query round-trip."""
    return f"jockey-{plan_id}"


def _jockey_ddb_plan_item(row: dict) -> dict:
    return {k: _ddb_value(v) for k, v in row.items() if v is not None}


def _jockey_validate_schedule(expr: str) -> Optional[str]:
    expr = (expr or "").strip()
    if not expr:
        return "schedule_expression is required (e.g. 'rate(1 day)' or 'cron(0 9 * * ? *)')"
    if not (expr.startswith("rate(") or expr.startswith("cron(") or expr.startswith("at(")):
        return (
            f"schedule_expression must start with rate(…), cron(…), or at(…); "
            f"got {expr!r}"
        )
    return None


@tool
def jockey_save(
    prompt: str,
    knowledge_store_id: str,
    schedule_expression: str,
    description: Optional[str] = None,
) -> dict:
    """Save a mining plan: a prompt the agent should re-run on a schedule.

    Creates both the plan row (in `JOCKEY_PLANS_TABLE`) AND the matching
    EventBridge Schedule in the mining group. The Schedule's target is the
    mining-run Lambda; each fire invokes the Lambda with
    `{"plan_id": "..."}`, the Lambda loads the plan, invokes the AgentCore
    runtime with the saved prompt, and writes a `jockey_runs` row.

    Args:
        prompt: the agent instruction to run each fire (e.g. "find any new
            tense sports highlights added to this KS in the last 24h and
            draft a 30s rough cut").
        knowledge_store_id: the KS the plan runs against (ks_...).
        schedule_expression: EventBridge expression — `rate(N unit)` or
            `cron(fields)` or `at(ISO-time)` for a one-shot. See
            docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html.
        description: optional human-readable name shown in list / history.

    Returns:
        {plan_id, schedule_arn, status: "saved"} on success, or
        {"error": "..."} on failure.
    """
    if not prompt:
        return {"error": "prompt is required"}
    if not knowledge_store_id:
        return {"error": "knowledge_store_id is required"}
    if not JOCKEY_PLANS_TABLE:
        return {"error": "JOCKEY_PLANS_TABLE env var not set"}
    if not MINING_SCHEDULER_GROUP or not MINING_RUN_LAMBDA_ARN or not MINING_SCHEDULER_TARGET_ROLE_ARN:
        return {"error": "mining scheduler env vars not set (MINING_SCHEDULER_GROUP / MINING_RUN_LAMBDA_ARN / MINING_SCHEDULER_TARGET_ROLE_ARN)"}
    schedule_err = _jockey_validate_schedule(schedule_expression)
    if schedule_err:
        return {"error": schedule_err}

    plan_id = uuid.uuid4().hex[:24]
    created_at = _utcnow_iso()
    sched_name = _jockey_schedule_name(plan_id)

    item: dict = {
        "plan_id":             {"S": plan_id},
        "knowledge_store_id":  {"S": knowledge_store_id},
        "prompt":              {"S": prompt},
        "schedule_expression": {"S": schedule_expression},
        "schedule_name":       {"S": sched_name},
        "created_at":          {"S": created_at},
        "enabled":             {"BOOL": True},
    }
    if description:
        item["description"] = {"S": description}
    try:
        _ddb.put_item(TableName=JOCKEY_PLANS_TABLE, Item=item)
    except Exception as e:
        return {"error": f"ddb put_item failed: {e}"}

    try:
        resp = _scheduler.create_schedule(
            Name=sched_name,
            GroupName=MINING_SCHEDULER_GROUP,
            ScheduleExpression=schedule_expression,
            FlexibleTimeWindow={"Mode": "OFF"},
            Target={
                "Arn":     MINING_RUN_LAMBDA_ARN,
                "RoleArn": MINING_SCHEDULER_TARGET_ROLE_ARN,
                "Input":   json.dumps({"plan_id": plan_id}),
            },
            Description=description or f"Mining plan {plan_id} for {knowledge_store_id}",
        )
    except Exception as e:
        # Try to roll back the plan row to avoid orphaning. Best-effort.
        try:
            _ddb.delete_item(TableName=JOCKEY_PLANS_TABLE, Key={"plan_id": {"S": plan_id}})
        except Exception:
            pass
        return {"error": f"scheduler create_schedule failed: {e}"}

    sched_arn = resp.get("ScheduleArn", "")
    try:
        _ddb.update_item(
            TableName=JOCKEY_PLANS_TABLE,
            Key={"plan_id": {"S": plan_id}},
            UpdateExpression="SET schedule_arn = :a",
            ExpressionAttributeValues={":a": {"S": sched_arn}},
        )
    except Exception:
        pass

    return {
        "plan_id":             plan_id,
        "schedule_arn":        sched_arn,
        "schedule_expression": schedule_expression,
        "knowledge_store_id":  knowledge_store_id,
        "created_at":          created_at,
        "status":              "saved",
    }


@tool
def jockey_list(
    knowledge_store_id: Optional[str] = None,
    limit: int = 25,
) -> dict:
    """List mining plans, optionally filtered to one knowledge store.

    Args:
        knowledge_store_id: optional ks_... filter. When omitted, scans the
            whole table (bounded by `limit`).
        limit: how many plans to return (hard cap 100).

    Returns:
        {plans: [{plan_id, knowledge_store_id, prompt, schedule_expression,
         description, created_at, enabled}, ...]}.
    """
    if not JOCKEY_PLANS_TABLE:
        return {"error": "JOCKEY_PLANS_TABLE env var not set"}
    limit = max(1, min(_JOCKEY_MAX_LIST, int(limit)))
    knowledge_store_id = _sel_default("knowledge_store_id", knowledge_store_id)
    try:
        if knowledge_store_id:
            r = _ddb.query(
                TableName=JOCKEY_PLANS_TABLE,
                IndexName="by-ks",
                KeyConditionExpression="knowledge_store_id = :k",
                ExpressionAttributeValues={":k": {"S": knowledge_store_id}},
                ScanIndexForward=False,  # newest first
                Limit=limit,
            )
        else:
            r = _ddb.scan(TableName=JOCKEY_PLANS_TABLE, Limit=limit)
    except Exception as e:
        return {"error": f"ddb query failed: {e}"}
    rows = r.get("Items") or []
    return {"plans": [_jockey_ddb_plan_item(row) for row in rows]}


@tool
def jockey_run(
    plan_id: str,
    wait: bool = True,
) -> dict:
    """Run a saved mining plan on demand (synchronously invokes the
    mining-run Lambda). Returns the Lambda's response: {plan_id, run_id,
    status, result_preview, tool_path} on success.

    Args:
        plan_id: the id returned by jockey_save.
        wait: True (default) runs synchronously (lambda:Invoke with
            RequestResponse); False fires the Lambda async and returns
            {status: "triggered"}.

    Returns:
        Lambda response dict on sync, or {"status": "triggered", "plan_id":...}
        on async, or {"error": "..."} on failure.
    """
    if not plan_id:
        return {"error": "plan_id is required"}
    if not MINING_RUN_LAMBDA_ARN:
        return {"error": "MINING_RUN_LAMBDA_ARN env var not set"}
    payload = json.dumps({"plan_id": plan_id}).encode()
    try:
        resp = _lambda.invoke(
            FunctionName=MINING_RUN_LAMBDA_ARN,
            InvocationType="RequestResponse" if wait else "Event",
            Payload=payload,
        )
    except Exception as e:
        return {"error": f"lambda invoke failed: {e}"}
    if not wait:
        return {"status": "triggered", "plan_id": plan_id}
    body_bytes = resp.get("Payload").read() if resp.get("Payload") else b""
    try:
        body = json.loads(body_bytes)
    except Exception:
        body = {"raw": body_bytes.decode("utf-8", errors="replace")[:400]}
    if resp.get("FunctionError"):
        return {"error": f"lambda function error: {body}"}
    return body


@tool
def jockey_list_runs(
    plan_id: str,
    limit: int = 20,
) -> dict:
    """List recent runs of a mining plan, newest first.

    Args:
        plan_id: the plan to list runs for.
        limit: how many runs to return (hard cap 100).

    Returns:
        {plan_id, runs: [{run_id, status, started_at, completed_at,
         result_text, error, tool_path}, ...]}.
    """
    if not plan_id:
        return {"error": "plan_id is required"}
    if not JOCKEY_RUNS_TABLE:
        return {"error": "JOCKEY_RUNS_TABLE env var not set"}
    limit = max(1, min(_JOCKEY_MAX_LIST, int(limit)))
    try:
        r = _ddb.query(
            TableName=JOCKEY_RUNS_TABLE,
            KeyConditionExpression="plan_id = :p",
            ExpressionAttributeValues={":p": {"S": plan_id}},
            ScanIndexForward=False,
            Limit=limit,
        )
    except Exception as e:
        return {"error": f"ddb query failed: {e}"}
    rows = r.get("Items") or []
    return {"plan_id": plan_id, "runs": [_jockey_ddb_plan_item(row) for row in rows]}


# ═══ Tier 2: Live grounding via Bedrock Pegasus ═══════════════════════════════

@tool
def pegasus_analyze(
    target: str,
    prompt: str,
    target_type: str = "asset_id",
    max_tokens: int = 1024,
    temperature: float = 0.2,
    response_schema: Optional[dict] = None,
    reference_images: Optional[list] = None,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> str:
    """Generate a take-note about a specific clip using Bedrock Pegasus 1.5.
    Use when the producer asks what a clip visibly contains (subject, action,
    framing, mood, dialogue) — questions a similarity score cannot answer.
    **Check lookup_asset_profile first** — the cached one_liner often suffices.

    Reads s3://CLIPS_BUCKET_NAME/clips/<asset_id>.mp4 directly with the
    runtime's IAM role; no media leaves the customer account.

    Args:
        target: asset_id (24-hex).
        prompt: instruction for Pegasus.
        target_type: kept for backward compat; only "asset_id" is supported.
        max_tokens: response cap (512-98304). Bedrock Pegasus 1.5 raised the
            ceiling from 1.2's 4096.
        temperature: sampling temperature.
        response_schema: optional JSON Schema dict. When set, Pegasus returns
            `message` as a JSON string conforming to the schema; parse it
            yourself. Pass just the schema object (not {"type": "json_schema"}).
        reference_images: optional list of image refs to attach as visual
            context. Each entry may be a URL (s3:// or http(s)://), a
            `data:image/<type>;base64,<...>` string, or raw base64. Images
            get auto-named ref_0, ref_1, ... and Pegasus 1.5 requires the
            prompt to reference each image via its `<@name>` placeholder
            (e.g. "Does <@ref_0> appear in this clip?"). If the prompt
            doesn't include placeholders, this tool prepends them.
        start_time: optional sub-clip window start in seconds. When set,
            Pegasus bounds analysis to the window instead of ingesting the
            whole file. Pass without end_time for an open-ended tail.
        end_time: optional sub-clip window end in seconds. Pass without
            start_time for an open-ended head.

    Returns:
        Pegasus's grounded text response. If the generation was cut off by
        max_tokens, the string ends with "[truncated: hit max_tokens]".
    """
    # Selections defaulting (PR #8): if the agent didn't pass target /
    # bounds, fall back to the first selection in the user's working set.
    target = _sel_default("asset_id", target)
    start_time = _sel_default("start_sec", start_time)
    end_time = _sel_default("end_sec", end_time)
    if not target:
        return "error: target asset_id is required"
    if not prompt:
        return "error: prompt is required"
    if target_type != "asset_id":
        return "error: only target_type='asset_id' is supported in the AWS-native build"
    return _pegasus_bedrock(
        target, prompt, temperature,
        max_output_tokens=max_tokens,
        response_schema=response_schema,
        reference_images=reference_images,
        start_time=start_time,
        end_time=end_time,
    )


# ─── Wave-2 PR #6: QA-item tool + per-item DDB cache ─────────────────────────

PEGASUS_QA_MODEL_ID = os.environ.get(
    "PEGASUS_BEDROCK_MODEL_ID",
    "us.twelvelabs.pegasus-1-5-v1:0",
)


@tool
def qa_item(
    asset_id: str,
    question: str,
    modality: str = "auto",
    knowledge_store_id: Optional[str] = None,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
    use_cache: bool = True,
) -> dict:
    """Ask a specific question about one asset and get a grounded answer
    with cache metadata. Backed by Bedrock Pegasus 1.5 with a per-item
    DDB cache under kb_cache (sk prefix `QA#<asset_id>#`).

    Prefer this over calling `pegasus_analyze` directly when:
      - the question is answerable from a single clip, and
      - the same question may be asked again later in this session or by
        another user (the cache cuts repeat Pegasus spend to a single
        sub-10ms DDB GetItem).

    For broad "describe this clip" asks or when you need fine control
    over the Pegasus prompt / schema, call `pegasus_analyze` directly;
    this tool is for repeated question-shaped queries.

    Args:
        asset_id: 24-hex asset_id. Alias handles (`@id_N`) accepted.
        question: free-text question about the asset.
        modality: "auto" | "visual" | "audio". "auto" classifies the
            question from its wording. "visual" / "audio" force a
            modality-shaped prompt prefix so Pegasus biases attention.
        knowledge_store_id: ks_xxxxxxxx (defaults from current selection).
        start_time / end_time: optional sub-clip bounds in seconds. The
            window is baked into the cache key so answers over 0-10s
            don't collide with answers over 10-20s.
        use_cache: when False, bypass the DDB read (still writes on
            success). Useful if the operator suspects a stale answer.

    Returns:
        {asset_id, question, modality, answer, cached, cached_at?,
         model_id, source: "pegasus_live"|"qa_cache"}
    """
    asset_id = resolve_alias(asset_id)
    asset_id = _sel_default("asset_id", asset_id)
    knowledge_store_id = _sel_default("knowledge_store_id", knowledge_store_id)
    start_time = _sel_default("start_sec", start_time)
    end_time = _sel_default("end_sec", end_time)

    if not asset_id:
        return {"error": "asset_id is required"}
    if not isinstance(question, str) or not question.strip():
        return {"error": "question is required"}
    if not knowledge_store_id:
        return {"error": "knowledge_store_id required (or set via selections)"}

    resolved_modality = _qa_resolve_modality(modality, question)

    # Cache read.
    if use_cache and KB_CACHE_TABLE:
        sk = _qa_cache_key(asset_id, resolved_modality, question, start_time, end_time)
        try:
            hit = _ddb_kb_get(f"ks#{knowledge_store_id}", sk)
        except Exception as e:
            print(f"qa_item: cache read failed: {e}")
            hit = None
        if hit:
            return aliasify_result(_qa_from_cached_row(hit))

    # Cache miss → call Pegasus with a modality-shaped prompt.
    shaped = _qa_shape_prompt(resolved_modality, question)
    answer = _pegasus_bedrock(
        asset_id, shaped, 0.2,
        max_output_tokens=1024,
        response_schema=None,
        reference_images=None,
        start_time=start_time,
        end_time=end_time,
    )
    # pegasus_analyze returns a string. Error paths return a string
    # starting with "error:" — don't cache those.
    cacheable = isinstance(answer, str) and not answer.lower().startswith("error:")

    if cacheable and KB_CACHE_TABLE:
        try:
            _ddb.put_item(
                TableName=KB_CACHE_TABLE,
                Item=_qa_cache_row(
                    asset_id=asset_id,
                    knowledge_store_id=knowledge_store_id,
                    modality=resolved_modality,
                    question=question,
                    answer=answer,
                    start_sec=start_time,
                    end_sec=end_time,
                    model_id=PEGASUS_QA_MODEL_ID,
                ),
            )
        except Exception as e:
            print(f"qa_item: cache write failed: {e}")

    result = {
        "asset_id":  asset_id,
        "question":  question,
        "modality":  resolved_modality,
        "answer":    answer,
        "cached":    False,
        "model_id":  PEGASUS_QA_MODEL_ID,
        "source":    "pegasus_live",
    }
    if start_time is not None:
        result["start_sec"] = start_time
    if end_time is not None:
        result["end_sec"] = end_time
    return aliasify_result(result)


@tool
def pegasus_segments(
    target: str,
    segment_definitions: list,
    max_tokens: int = 4096,
    temperature: float = 0.0,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> str:
    """Extract structured, timestamped segments from a clip using Pegasus 1.5
    `time_based_metadata` mode. Pegasus auto-segments the video and populates
    the fields you define for each segment.

    Use when the producer asks for a structured breakdown: "chapterize this
    trailer", "list every shot with a speaking subject", "mark the beats
    and label each one with mood + visible subjects". Combine with
    `start_time`/`end_time` to segment only a window of a long clip (e.g.
    chapterize minute 10-15 of a broadcast) instead of the whole file.

    Args:
        target: asset_id (24-hex).
        segment_definitions: list of segment-type definitions. Each dict must
            carry `id` (slug), `description` (what qualifies as a segment of
            this type), and `fields` (list of {name, type, description}). See
            the Pegasus 1.5 Bedrock docs for the schema. Example:
                [{"id": "shots",
                  "description": "A single camera take.",
                  "fields": [
                    {"name": "summary", "type": "string",
                     "description": "What happens in the shot."},
                    {"name": "mood", "type": "string",
                     "description": "Dominant mood (energetic|calm|tense|…)"}
                  ]}]
        max_tokens: response cap (512-98304).
        temperature: sampling temperature (lower is more deterministic for
            structured output; defaults to 0).
        start_time: optional window start in seconds; segmentation is
            constrained to the window.
        end_time: optional window end in seconds.

    Returns:
        JSON string: `{"segments": [...], "definition_errors": [...]}`.
        Parse it to iterate segments; each carries `id`, `start_sec`,
        `end_sec`, and the fields declared in its matching definition.
    """
    # Selections defaulting (PR #8): if the agent didn't pass target /
    # bounds, fall back to the first selection in the user's working set.
    target = _sel_default("asset_id", target)
    start_time = _sel_default("start_sec", start_time)
    end_time = _sel_default("end_sec", end_time)
    if not target:
        return "error: target asset_id is required"
    if not segment_definitions:
        return "error: segment_definitions must contain at least one definition"
    return _pegasus_bedrock(
        target, prompt=None, temperature=temperature,
        max_output_tokens=max_tokens,
        analysis_mode="time_based_metadata",
        segment_definitions=segment_definitions,
        start_time=start_time,
        end_time=end_time,
    )


def _resolve_image_to_media_source(ref: str, name: str) -> dict:
    """Resolve a reference-image spec to a Pegasus 1.5 `mediaSources[*]` entry
    `{name, mediaType, base64String}`.

    Important: Bedrock Pegasus 1.5 requires `mediaType` to be the literal
    string "image" (NOT a MIME type like "image/png" — that's rejected as
    extraneous).

    Accepts:
        - `data:image/<type>;base64,<...>` — base64 payload extracted
        - `s3://bucket/key` or `http(s)://...` — fetched then base64-encoded
        - raw base64 — passed through
    """
    if ref.startswith("data:image/"):
        _, _, b64 = ref.partition(",")
        return {"name": name, "mediaType": "image", "base64String": b64}
    if ref.startswith(("s3://", "http://", "https://")):
        raw = _fetch_image_bytes(ref)
        return {
            "name": name,
            "mediaType": "image",
            "base64String": base64.b64encode(raw).decode(),
        }
    return {"name": name, "mediaType": "image", "base64String": ref}


def _pegasus_bedrock(
    asset_id: str,
    prompt: Optional[str],
    temperature: float,
    *,
    max_output_tokens: int = 1024,
    response_schema: Optional[dict] = None,
    reference_images: Optional[list] = None,
    analysis_mode: str = "general",
    segment_definitions: Optional[list] = None,
    start_time: Optional[float] = None,
    end_time: Optional[float] = None,
) -> str:
    # Sub-clip bounds (start_time / end_time, seconds, top-level, snake_case)
    # went live on Bedrock Pegasus 1.5 ~2026-10-16 — raw-invoke smoke confirmed
    # both acceptance (200 instead of the previous 400 "extraneous key not
    # permitted") and that the window is honored, not silently ignored (HEAD
    # 0-5s on a trailer returned "black screen" while TAIL 55-60s returned
    # "two moose in a forest"). The AWS docs page hasn't caught up yet.
    if not CLIPS_BUCKET_NAME or not CLIPS_BUCKET_OWNER:
        return "error: CLIPS_BUCKET_NAME / CLIPS_BUCKET_OWNER not configured"
    body: dict = {
        "analysis_mode": analysis_mode,
        "mediaSource": {
            "s3Location": {
                "uri": f"s3://{CLIPS_BUCKET_NAME}/clips/{asset_id}.mp4",
                "bucketOwner": CLIPS_BUCKET_OWNER,
            }
        },
        "temperature": temperature,
        "maxOutputTokens": max(512, min(98304, int(max_output_tokens))),
    }
    # Sub-clip bounds: pass as top-level `start_time` / `end_time` seconds.
    # Either may be set independently (open-ended range on the unset side).
    if start_time is not None:
        try:
            st = max(0.0, float(start_time))
        except (TypeError, ValueError):
            return f"error: start_time must be numeric (got {start_time!r})"
        body["start_time"] = st
    if end_time is not None:
        try:
            et = float(end_time)
        except (TypeError, ValueError):
            return f"error: end_time must be numeric (got {end_time!r})"
        if start_time is not None and et <= body.get("start_time", 0.0):
            return f"error: end_time ({et}) must be > start_time ({body['start_time']})"
        body["end_time"] = et
    if analysis_mode == "time_based_metadata":
        if not segment_definitions:
            return "error: segment_definitions required for time_based_metadata mode"
        body["segment_definitions"] = segment_definitions
    else:
        if not prompt:
            return "error: prompt is required for general analysis mode"
        if reference_images:
            # Pegasus 1.5 general mode routes reference images through
            # inputPromptV2.mediaSources. Each entry needs {name, mediaType:
            # "image", base64String}, and the prompt MUST reference each
            # image via its <@name> placeholder — plain text or @name is
            # silently dropped (verified via raw-invoke smoke 2026-10-15).
            # If the caller didn't include the placeholders, prepend them.
            sources = [
                _resolve_image_to_media_source(r, f"ref_{i}")
                for i, r in enumerate(reference_images)
            ]
            text = prompt
            if not any(f"<@{s['name']}>" in text for s in sources):
                refs = " ".join(f"<@{s['name']}>" for s in sources)
                text = f"Reference images: {refs}. {text}"
            body["inputPromptV2"] = {"input_text": text, "mediaSources": sources}
        else:
            body["inputPrompt"] = prompt
        if response_schema is not None:
            body["responseFormat"] = {"type": "json_schema", "jsonSchema": response_schema}
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
    if analysis_mode == "time_based_metadata":
        return json.dumps({
            "segments": payload.get("segments", []),
            "definition_errors": payload.get("definition_errors", []),
            "stopReason": payload.get("stopReason"),
        })
    text = payload.get("message") or "(no text returned)"
    if payload.get("stopReason") == "length":
        text = f"{text}\n\n[truncated: hit max_tokens]"
    return text


# ─── zoom_in_video: time-window-bounded Pegasus analysis ────────────────────
# Jockey's "zoom in" affordance: let the agent say "look again at seconds
# 15-30 of asset X" instead of re-analyzing the whole video. Uses Pegasus 1.5
# Bedrock's native start_time / end_time sub-clip bounds (threaded through
# _pegasus_bedrock), so the model actually scopes its attention to the window
# rather than ingesting the whole file.
_DEFAULT_ZOOM_PROMPT = (
    "Describe what happens in this clip in detail — the main action, who/what "
    "is on screen, and any notable audio or dialogue. Keep the answer focused "
    "on what is visible and audible."
)


@tool
def zoom_in_video(
    asset_id: str,
    start_sec: float,
    end_sec: float,
    question: Optional[str] = None,
    temperature: float = 0.1,
) -> dict:
    """Deep-dive Pegasus analysis bounded to a specific time window of a clip.

    Prefer this over `pegasus_analyze` when the question is about a specific
    moment ("what happens at 15-30s", "describe the chase at 1:02-1:18"). The
    tool delegates to `_pegasus_bedrock` with the sub-clip `start_time` /
    `end_time` kwargs set, so Pegasus 1.5 scopes its attention to the window
    at the model level — not via prompt wording.

    Args:
        asset_id: 24-char hex asset id (same bytes `pegasus_analyze` reads).
        start_sec: window start in seconds (clamped to 0 by `_pegasus_bedrock`).
        end_sec: window end in seconds; must be > start_sec.
        question: optional focused question ("what is the ref signaling?").
            Falls back to a generic "describe the window" prompt when omitted.
        temperature: sampling temperature; defaults lower than pegasus_analyze.

    Returns:
        {asset_id, start_sec, end_sec, duration_sec, question, text}. `text`
        is Pegasus's grounded response.
    """
    # Selections defaulting (PR #8): if the agent didn't pass asset_id or
    # bounds, fall back to the first selection in the user's working set.
    asset_id = _sel_default("asset_id", asset_id)
    start_sec = _sel_default("start_sec", start_sec)
    end_sec = _sel_default("end_sec", end_sec)
    if not asset_id:
        return {"error": "asset_id is required"}
    if start_sec is None or end_sec is None:
        return {"error": "start_sec and end_sec required (pass directly or via selections[0])"}
    try:
        start_sec = max(0.0, float(start_sec))
        end_sec = float(end_sec)
    except (TypeError, ValueError):
        return {"error": "start_sec and end_sec must be numbers"}
    if end_sec <= start_sec:
        return {"error": f"end_sec ({end_sec}) must be > start_sec ({start_sec})"}
    prompt = (question or "").strip() or _DEFAULT_ZOOM_PROMPT
    text = _pegasus_bedrock(
        asset_id, prompt, temperature,
        start_time=start_sec,
        end_time=end_sec,
    )
    return {
        "asset_id":     asset_id,
        "start_sec":    start_sec,
        "end_sec":      end_sec,
        "duration_sec": round(end_sec - start_sec, 3),
        "question":     question,
        "text":         text,
    }


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


# ═══ Generation tools (PR #11): html app / video / code ═════════════════════

# ─── generate_html_app via Claude Sonnet on Bedrock ─────────────────────────
_HTML_APP_SYSTEM = (
    "You generate complete, self-contained single-page HTML applications. "
    "Output ONLY the HTML — no markdown fences, no commentary, no explanation. "
    "Start with <!DOCTYPE html> and end with </html>. All CSS inline in <style>; "
    "all JavaScript inline in <script>. No external script or stylesheet URLs. "
    "Modern browser-native APIs only; no framework imports."
)
_HTML_APP_DEFAULT_MAX_TOKENS = 8192


@tool
def generate_html_app(
    spec: str,
    max_tokens: int = _HTML_APP_DEFAULT_MAX_TOKENS,
    temperature: float = 0.2,
    title: Optional[str] = None,
) -> dict:
    """Generate a self-contained single-page HTML application from a spec.

    Uses Claude Sonnet on Bedrock. Returns the full HTML string plus
    metadata. **Does not persist the output** — chain to `save_artifact`
    (kind='html.app') when the user wants the file retained for sharing.

    Args:
        spec: natural-language description of the app ("A results browser
            for these 5 Highlight clips: ..."). Include concrete data and
            layout intent; the model fills in details.
        max_tokens: ceiling for the generation (default 8192).
        temperature: sampling temperature; 0.2 keeps the output stable.
        title: optional title echoed back in the response for the caller.

    Returns:
        {html, size_bytes, title, truncated}. `truncated=True` means Claude
        hit max_tokens — bump the budget and retry.
    """
    if not spec:
        return {"error": "spec is required"}
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens":        max(512, min(8192, int(max_tokens))),
        "temperature":       float(temperature),
        "system":            _HTML_APP_SYSTEM,
        "messages": [{"role": "user", "content": spec}],
    }
    try:
        resp = _bedrock_rt.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(resp["body"].read())
    except Exception as e:
        return {"error": f"bedrock invoke failed: {e}"}
    # Messages API returns {content: [{type:"text", text:"..."}], stop_reason: ...}
    blocks = payload.get("content") or []
    html_parts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
    html = "".join(html_parts).strip()
    # Strip a stray markdown code fence if the model slipped one in.
    if html.startswith("```"):
        html = html.split("\n", 1)[1] if "\n" in html else ""
        if html.endswith("```"):
            html = html.rsplit("```", 1)[0]
        html = html.strip()
    return {
        "html":        html,
        "size_bytes":  len(html.encode("utf-8")),
        "title":       title,
        "truncated":   payload.get("stop_reason") == "max_tokens",
    }


# ─── generate_video via the stitch MediaConvert Lambda ──────────────────────
# The stitch lambda already composes an EDL into a playable MP4 via
# MediaConvert. We invoke it directly (lambda:Invoke RequestResponse) with an
# HTTP-API-shaped event so stitch's existing handler needs no changes.
@tool
def generate_video(edl_plan: dict) -> dict:
    """Render an EDL plan to a playable MP4 by invoking the stitch pipeline.

    Delegates to the existing MediaConvert path (lambda/stitch) so the agent
    gets the same semantics as the UI's "Render preview" button without
    duplicating job-building. Synchronous invoke — returns once stitch has
    submitted the MediaConvert job and reports back the job id + preview URL.
    MediaConvert completion itself is async; poll
    `GET /stitch/{job_id}` or inspect `s3://CLIPS_BUCKET/stitched/<id>/`.

    Args:
        edl_plan: the EDL plan dict (same shape the SYSTEM_PROMPT emits in
            `<plan>...</plan>`). Must include `scenes[].clips[]` with
            `asset_id`, `start_time`, `end_time`.

    Returns:
        {job_id, status, preview_url, raw}. `raw` carries the full stitch
        response for debugging. `preview_url` is populated once the stitch
        lambda knows the destination; it serves at CloudFront `/stitched/`.
    """
    edl_plan = dealias_dict(edl_plan) if isinstance(edl_plan, dict) else edl_plan
    if not isinstance(edl_plan, dict):
        return {"error": "edl_plan must be a dict"}
    if not STITCH_LAMBDA_ARN:
        return {"error": "STITCH_LAMBDA_ARN env var not set"}
    event = {
        "requestContext":   {"http": {"method": "POST"}},
        "rawPath":          "/stitch",
        "headers":          {"content-type": "application/json"},
        "body":             json.dumps({"plan": edl_plan}),
        "isBase64Encoded":  False,
    }
    try:
        resp = _lambda.invoke(
            FunctionName=STITCH_LAMBDA_ARN,
            InvocationType="RequestResponse",
            Payload=json.dumps(event).encode(),
        )
    except Exception as e:
        return {"error": f"stitch invoke failed: {e}"}
    if resp.get("FunctionError"):
        try:
            err_body = json.loads(resp["Payload"].read()) if resp.get("Payload") else {}
        except Exception:
            err_body = {}
        return {"error": f"stitch function error: {err_body}"}
    try:
        body_bytes = resp.get("Payload").read() if resp.get("Payload") else b"{}"
        gw_response = json.loads(body_bytes)
    except Exception as e:
        return {"error": f"stitch response parse failed: {e}"}
    inner = {}
    if isinstance(gw_response, dict) and "body" in gw_response:
        try:
            inner = json.loads(gw_response["body"])
        except Exception:
            inner = {"raw_body": gw_response.get("body")}
    else:
        inner = gw_response if isinstance(gw_response, dict) else {}
    return {
        "job_id":       inner.get("jobId") or inner.get("job_id"),
        "status":       inner.get("status", "submitted"),
        "preview_url":  inner.get("outputUrl") or inner.get("preview_url"),
        "raw":          inner,
    }


# ─── execute_code: narrow safe-eval ────────────────────────────────────────
# Pure-Python expression (or short multi-statement) evaluator intended for
# "compute a quick number / munge a dict" style asks. Deliberately NOT a
# full code interpreter. Walks the AST and rejects:
#   - imports (Import, ImportFrom)
#   - defs (FunctionDef, AsyncFunctionDef, ClassDef, Lambda)
#   - attribute access except on allowed objects (there are none in scope)
#   - calls to anything outside the _SAFE_CALLABLES allowlist
#   - any name reference outside _SAFE_NAMES
# Full Bedrock AgentCore Code Interpreter integration is a focused follow-up
# when that primitive is stable; this covers the long tail cheaply.

_SAFE_CALLABLES = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "divmod": divmod,
    "enumerate": enumerate, "filter": filter, "float": float, "int": int, "len": len,
    "list": list, "map": map, "max": max, "min": min, "range": range, "repr": repr,
    "reversed": reversed, "round": round, "set": set, "sorted": sorted, "str": str,
    "sum": sum, "tuple": tuple, "zip": zip,
}
_SAFE_NAMES = set(_SAFE_CALLABLES.keys()) | {"True", "False", "None"}
_FORBIDDEN_NODES = (
    _ast.Import, _ast.ImportFrom,
    _ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef, _ast.Lambda,
    _ast.Attribute,
    _ast.Try, _ast.Raise, _ast.Global, _ast.Nonlocal,
    _ast.With, _ast.AsyncWith, _ast.AsyncFor,
    _ast.Yield, _ast.YieldFrom, _ast.Await,
)
_EXECUTE_CODE_SIZE_LIMIT = 4096


def _collect_local_names(tree: _ast.AST) -> set[str]:
    """Names the snippet itself defines — assignment targets, for-loop vars,
    comprehension targets. Any such name is safe to read later in the snippet."""
    locals_: set[str] = set()
    for node in _ast.walk(tree):
        if isinstance(node, _ast.Assign):
            for t in node.targets:
                for n in _ast.walk(t):
                    if isinstance(n, _ast.Name):
                        locals_.add(n.id)
        elif isinstance(node, (_ast.AugAssign, _ast.AnnAssign, _ast.NamedExpr)):
            tgt = node.target
            if isinstance(tgt, _ast.Name):
                locals_.add(tgt.id)
        elif isinstance(node, (_ast.For, _ast.comprehension)):
            for n in _ast.walk(node.target):
                if isinstance(n, _ast.Name):
                    locals_.add(n.id)
    return locals_


def _validate_safe_ast(tree: _ast.AST) -> Optional[str]:
    allowed_names = _SAFE_NAMES | _collect_local_names(tree)
    for node in _ast.walk(tree):
        if isinstance(node, _FORBIDDEN_NODES):
            return f"forbidden syntax: {type(node).__name__}"
        if isinstance(node, _ast.Name):
            if node.id not in allowed_names and not isinstance(node.ctx, _ast.Store):
                return f"name not allowed: {node.id!r} (not in safe allowlist)"
        if isinstance(node, _ast.Call):
            func = node.func
            if isinstance(func, _ast.Name):
                if func.id not in _SAFE_CALLABLES and func.id not in allowed_names:
                    return f"call to disallowed name: {func.id!r}"
            else:
                return "only direct name calls are allowed"
    return None


@tool
def execute_code(code: str) -> dict:
    """Evaluate a short Python snippet in a narrow sandbox and return the result.

    **Not a full code interpreter.** Pure Python only, no imports, no I/O,
    no network, no attribute access. The AST is walked and rejects any
    forbidden syntax before execution. Intended for arithmetic, string
    manipulation, basic list/dict/set wrangling — the long tail of
    "compute a quick number" asks. For heavier work (ML, HTTP, file
    reads), raise it as a limitation to the user.

    Allowed callables: abs, all, any, bool, dict, divmod, enumerate,
    filter, float, int, len, list, map, max, min, range, repr, reversed,
    round, set, sorted, str, sum, tuple, zip.

    Args:
        code: a single expression OR a short statement block whose last
            line is an expression. 4096-byte input cap.

    Returns:
        {result, repr, mode}. On any failure (parse error, forbidden
        syntax, or runtime exception): {"error": "..."}.
    """
    if not isinstance(code, str) or not code.strip():
        return {"error": "code is required (non-empty string)"}
    if len(code.encode("utf-8")) > _EXECUTE_CODE_SIZE_LIMIT:
        return {"error": f"code exceeds {_EXECUTE_CODE_SIZE_LIMIT} byte limit"}
    try:
        tree = _ast.parse(code, mode="exec")
    except SyntaxError as e:
        return {"error": f"syntax error: {e}"}
    reason = _validate_safe_ast(tree)
    if reason:
        return {"error": reason}
    # Try to evaluate the LAST statement as an expression if it is one, so
    # the agent sees "x + 1" style one-liners' value in `result`.
    globals_dict: dict = {"__builtins__": {}, **_SAFE_CALLABLES}
    locals_dict: dict = {}
    mode = "exec"
    last_result = None
    try:
        if tree.body and isinstance(tree.body[-1], _ast.Expr):
            # Separate the trailing expression so we can both exec the lead-in
            # and eval the final expression.
            lead = _ast.Module(body=tree.body[:-1], type_ignores=[])
            tail = _ast.Expression(body=tree.body[-1].value)
            if tree.body[:-1]:
                exec(compile(lead, "<execute_code>", "exec"), globals_dict, locals_dict)
            last_result = eval(compile(tail, "<execute_code>", "eval"), globals_dict, locals_dict)
            mode = "exec+eval"
        else:
            exec(compile(tree, "<execute_code>", "exec"), globals_dict, locals_dict)
    except Exception as e:
        return {"error": f"runtime: {type(e).__name__}: {e}"}
    try:
        rendered = repr(last_result)[:1000]
    except Exception:
        rendered = "<unreprable>"
    try:
        serializable = json.loads(json.dumps(last_result))
    except (TypeError, ValueError):
        serializable = rendered
    return {"result": serializable, "repr": rendered, "mode": mode}


# ═══ Wave-2 PR #7: Hosted web search + citations ═════════════════════════════

@tool
def web_search(query: str, max_results: int = 5) -> dict:
    """Query a hosted web-search provider and return citation-shaped
    results. Use when the user asks about current events, recent product
    releases, specific people / titles / dates the KB can't ground, or
    any question whose answer sits outside the uploaded video corpus.

    The specific provider (Brave, Google CSE, SerpAPI, ...) is picked by
    the deployment's `WEB_SEARCH_PROVIDER` env var. The tool is callable
    even when no provider is configured; in that case it returns
    `configured: false` with an explanation, so you can tell the user
    that web search isn't available on this deployment.

    Args:
        query: free-text search string.
        max_results: 1-10 (clamped). Default 5.

    Returns:
        {query, provider, configured, results: [{title, url, snippet,
         published_at?, source}], error?}

    Guidance:
        - Always include the `url` of every result you cite in your reply
          so the producer can click through to verify.
        - If `configured` is false, surface that limitation to the user
          instead of hallucinating facts.
        - If `error` is set with `configured: true`, the provider is
          wired but momentarily failed (rate limit, 5xx) — retry once
          or fall back to an answer based on the agent's own knowledge
          with a caveat.
    """
    return _web_search(query, max_results)


# ═══ Phase 3 v0.4: Rekognition + Marengo hybrid image search ═════════════════
# Replaces the bespoke gdino+TAO+Titan pipeline. Per the 4-way eval in
# docs/v0.4-plan.md:
#
#   - Rekognition Faces is best-in-class on face/identity precision
#     (MRR 0.77 on trailers vs 0.50 for Titan).
#   - Marengo image-query against the already-populated `clips` index is
#     a free fallback for non-face content (helmets, profile shots,
#     non-celebrities) where Rekognition returns nothing.
#
# The reference image is passed in as s3:// or https://; the agent
# resolves it via _fetch_image_bytes() then routes through both
# backends as needed.

import hashlib as _hashlib  # noqa: E402
import time as _time  # noqa: E402
import uuid as _uuid  # noqa: E402

MARENGO_FOUNDATION_ARN = (
    f"arn:aws:bedrock:{AWS_REGION}::foundation-model/twelvelabs.marengo-embed-3-0-v1:0"
)
MARENGO_ASYNC_TIMEOUT_S = 60
MARENGO_MIN_DIM = 128  # Marengo rejects images smaller than 128x128
MARENGO_EMBED_CACHE_PREFIX = "embed-cache/marengo/"


def _ensure_min_dim(image_bytes: bytes) -> bytes:
    """Upscale (preserving aspect) if either dimension is below
    MARENGO_MIN_DIM. Marengo rejects sub-128 inputs outright."""
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        return image_bytes  # caller will get a Marengo error if it's too small
    import io
    im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = im.size
    if w >= MARENGO_MIN_DIM and h >= MARENGO_MIN_DIM:
        return image_bytes
    scale = max(MARENGO_MIN_DIM / w, MARENGO_MIN_DIM / h)
    new_size = (max(MARENGO_MIN_DIM, int(w * scale)), max(MARENGO_MIN_DIM, int(h * scale)))
    resized = im.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    resized.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _marengo_embed_image_cached(image_bytes: bytes) -> list[float]:
    """sha256-cached Marengo image embed via StartAsyncInvoke. Cache key
    is `embed-cache/marengo/<sha256>.json` in the clips bucket. Cache
    miss path: upload image → StartAsyncInvoke → poll → parse → put
    cache. Repeat queries on the same reference image return in <50ms."""
    if not (CLIPS_BUCKET_NAME and AWS_ACCOUNT_ID):
        raise RuntimeError("CLIPS_BUCKET_NAME + AWS_ACCOUNT_ID required for Marengo embed")

    sha = _hashlib.sha256(image_bytes).hexdigest()
    cache_key = f"{MARENGO_EMBED_CACHE_PREFIX}{sha}.json"
    try:
        cached = _s3.get_object(Bucket=CLIPS_BUCKET_NAME, Key=cache_key)
        payload = json.loads(cached["Body"].read())
        v = payload.get("embedding") or []
        if v:
            return v
    except _s3.exceptions.NoSuchKey:
        pass
    except Exception:
        pass  # treat any cache-read error as a miss

    upscaled = _ensure_min_dim(image_bytes)
    in_key = f"async-in-eval/{_uuid.uuid4().hex}.jpg"
    _s3.put_object(
        Bucket=CLIPS_BUCKET_NAME, Key=in_key,
        Body=upscaled, ContentType="image/jpeg",
    )

    body = {
        "inputType": "image",
        "image": {
            "mediaSource": {
                "s3Location": {
                    "uri": f"s3://{CLIPS_BUCKET_NAME}/{in_key}",
                    "bucketOwner": AWS_ACCOUNT_ID,
                }
            }
        },
    }
    resp = _bedrock_rt.start_async_invoke(
        modelId=MARENGO_FOUNDATION_ARN,
        modelInput=body,
        outputDataConfig={"s3OutputDataConfig": {"s3Uri": f"s3://{CLIPS_BUCKET_NAME}/async-out-eval/"}},
    )
    arn = resp["invocationArn"]
    t0 = _time.time()
    while _time.time() - t0 < MARENGO_ASYNC_TIMEOUT_S:
        s = _bedrock_rt.get_async_invoke(invocationArn=arn)
        status = s["status"]
        if status == "Completed":
            out_uri = s["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"]
            bucket = out_uri.split("/")[2]
            prefix = "/".join(out_uri.split("/")[3:])
            listing = _s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
            for obj in listing.get("Contents", []):
                if obj["Key"].endswith("output.json"):
                    data = json.loads(_s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read())
                    seg = (data.get("data") or [{}])[0]
                    v = seg.get("embedding") or []
                    if not v:
                        raise RuntimeError(f"Marengo returned no embedding: {json.dumps(data)[:200]}")
                    # Persist to cache for future invocations.
                    try:
                        _s3.put_object(
                            Bucket=CLIPS_BUCKET_NAME, Key=cache_key,
                            Body=json.dumps({"embedding": v, "model": "marengo-3-0", "dim": len(v)}).encode(),
                            ContentType="application/json",
                        )
                    except Exception:
                        pass  # cache write failure shouldn't break the query
                    return v
            raise RuntimeError(f"Marengo output.json missing under {out_uri}")
        if status == "Failed":
            raise RuntimeError(f"Marengo async failed: {s.get('failureMessage')}")
        _time.sleep(2)
    raise TimeoutError(f"Marengo async invocation exceeded {MARENGO_ASYNC_TIMEOUT_S}s")


@tool
def find_by_image(
    knowledge_store_id: str,
    reference_url: str,
    k: int = 10,
) -> dict:
    """**Find clips containing a person or scene from a reference image.**
    The v0.4 hybrid: Rekognition Faces first (fast, identity-precise),
    then Marengo visual-similarity fallback for queries Rekognition
    can't answer (profile shots, helmets, non-celebrities, non-face
    entities). Both backends are filtered to `knowledge_store_id`.

    Use this when the producer pastes a thumbnail and asks "find more
    clips with this person" or "find clips that look like this."

    Args:
        knowledge_store_id: ks_xxxxxxxx — selects the per-KS
            Rekognition collection (`<STACK_FQNAME>-ks-<ks_id>`) and
            filters the Marengo fallback's S3 Vectors query.
        reference_url: s3://bucket/key OR https://... pointing at the
            reference image (jpeg/png).
        k: how many distinct asset matches to return (default 10).

    Returns:
        {matches: [{asset_id, score, source}], rekognition_hits,
        marengo_hits, fallback_used}. `source` is "rekognition" or
        "marengo" so the caller can show which backend produced each
        match. Rekognition hits rank first (score = Similarity/100),
        Marengo hits follow (score = 1 - cosine_distance).
    """
    if not knowledge_store_id or not reference_url:
        return {"error": "knowledge_store_id and reference_url required"}
    if not STACK_FQNAME:
        return {"error": "STACK_FQNAME not configured"}

    try:
        img = _fetch_image_bytes(reference_url)
    except Exception as e:
        return {"error": f"image fetch failed: {e}"}

    # --- 1. Rekognition Faces (primary) ---
    collection_id = f"{STACK_FQNAME}-ks-{knowledge_store_id}"
    rek_matches: list[dict] = []
    rek_error: Optional[str] = None
    try:
        resp = _rek.search_faces_by_image(
            CollectionId=collection_id,
            Image={"Bytes": img},
            FaceMatchThreshold=80.0,
            MaxFaces=max(k * 4, 20),
            QualityFilter="AUTO",
        )
        seen: set[str] = set()
        for m in resp.get("FaceMatches") or []:
            aid = (m.get("Face") or {}).get("ExternalImageId")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            rek_matches.append({
                "asset_id": aid,
                "score":    round(float(m["Similarity"]) / 100.0, 4),
                "source":   "rekognition",
            })
    except _rek.exceptions.InvalidParameterException:
        # No face detected in the reference image — defer to Marengo.
        rek_error = "no_face_in_reference"
    except _rek.exceptions.ResourceNotFoundException:
        # Per-KS collection doesn't exist yet (KS never had any frames
        # IndexFaces'd, e.g. brand-new deploy). Fall through to Marengo.
        rek_error = "collection_missing"
    except Exception as e:
        rek_error = f"rekognition: {e}"

    # --- 2. Marengo fallback if we don't have enough good matches ---
    marengo_matches: list[dict] = []
    fallback_used = False
    if len(rek_matches) < k:
        fallback_used = True
        seen = {m["asset_id"] for m in rek_matches}
        try:
            qvec = _marengo_embed_image_cached(img)
            over_k = max(k * 8, 40)
            mresp = _s3v.query_vectors(
                vectorBucketName=VECTOR_BUCKET_NAME,
                indexName=VECTOR_INDEX_NAME,
                topK=over_k,
                queryVector={"float32": qvec},
                filter={"$and": [
                    {"knowledge_store_id": knowledge_store_id},
                    {"embedding_option":   "visual"},
                ]},
                returnMetadata=True,
                returnDistance=True,
            )
            # Dedupe by asset_id, keep best score per asset.
            best: dict[str, float] = {}
            for v in mresp.get("vectors") or []:
                aid = (v.get("metadata") or {}).get("asset_id")
                if not aid or aid in seen:
                    continue
                sim = 1.0 - float(v.get("distance") or 0.0)
                if sim > best.get(aid, -1):
                    best[aid] = sim
            for aid, s in sorted(best.items(), key=lambda kv: kv[1], reverse=True):
                marengo_matches.append({"asset_id": aid, "score": round(s, 4), "source": "marengo"})
        except Exception as e:
            return {
                "matches":          rek_matches[:k],
                "rekognition_hits": len(rek_matches),
                "marengo_hits":     0,
                "fallback_used":    True,
                "fallback_error":   f"marengo: {e}",
                **({"rekognition_error": rek_error} if rek_error else {}),
            }

    combined = (rek_matches + marengo_matches)[:k]
    return {
        "matches":          combined,
        "rekognition_hits": len(rek_matches),
        "marengo_hits":     len(marengo_matches),
        "fallback_used":    fallback_used,
        **({"rekognition_error": rek_error} if rek_error else {}),
    }


# ═══ Transcript / shot / audio-context tools ════════════════════════════════
# PR #5 of the roadmap: expose per-asset ASR, shot boundaries, and derived
# audio activity to the agent.
#
#   get_transcript       — reads the Transcribe JSON the ingest pipeline
#                          already landed at s3://CLIPS_BUCKET/transcripts/
#                          <asset_id>/<asset_id>.json. Pure S3 GetObject —
#                          no new model call.
#   get_shot_timeline    — Rekognition SegmentDetection (SHOT type).
#                          Cache-first via kb_cache SHOTS# rows; on miss,
#                          kicks off an async job and returns {pending,
#                          job_id}. Follow-up calls with job_id poll
#                          GetSegmentDetection and return the parsed cuts.
#   get_audio_context    — approximation layer. AWS has no first-party
#                          audio-event classifier, so we derive from the
#                          Transcribe items (speech vs. silence gaps) and
#                          Comprehend DetectSentiment on the transcript
#                          window text. Explicit about being an
#                          approximation in the docstring.

_rek_video_cli: Optional[object] = None
_comprehend_cli: Optional[object] = None


def _rek_video():
    global _rek_video_cli
    if _rek_video_cli is None:
        _rek_video_cli = boto3.client("rekognition", region_name=AWS_REGION)
    return _rek_video_cli


def _comprehend():
    global _comprehend_cli
    if _comprehend_cli is None:
        _comprehend_cli = boto3.client("comprehend", region_name=AWS_REGION)
    return _comprehend_cli


def _hhmmss_to_secs(s) -> float:
    """Accept 'HH:MM:SS' or a bare number of seconds; return seconds as float."""
    if s is None or s == "":
        return 0.0
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip()
    if ":" in s:
        parts = s.split(":")
        try:
            parts_f = [float(p) for p in parts]
        except ValueError:
            return 0.0
        if len(parts_f) == 3:
            h, m, sec = parts_f
        elif len(parts_f) == 2:
            h, m, sec = 0.0, parts_f[0], parts_f[1]
        else:
            h, m, sec = 0.0, 0.0, parts_f[0]
        return h * 3600 + m * 60 + sec
    try:
        return float(s)
    except ValueError:
        return 0.0


@tool
def get_transcript(
    asset_id: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    max_segments: int = 500,
) -> dict:
    """Return the ASR transcript for one asset. Reads the Transcribe JSON
    the ingest pipeline landed at `s3://CLIPS_BUCKET/transcripts/<asset_id>/
    <asset_id>.json` — this is a cached read, not a fresh transcription
    call, so the latency is a single S3 GetObject.
    Use whenever the brief needs "what's said in this clip" or "who's being
    quoted" — much cheaper than a `pegasus_analyze` prompt that asks for
    dialogue, and more accurate for speech content.
    Args:
        asset_id: 24-char hex.
        start_time: optional HH:MM:SS (or seconds) lower bound; segments
            that end before this are dropped.
        end_time:   optional HH:MM:SS (or seconds) upper bound.
        max_segments: cap on returned segments (default 500 — one
            Transcribe segment ≈ 5–15 s of audio).
    Returns:
        {found, asset_id, language, full_text, segments: [{start_sec,
        end_sec, text}], segment_count, truncated}.
        found=False → transcript hasn't landed yet (enrich_transcribe_start
        hasn't run or is still processing). Fall through to `pegasus_analyze`
        with a transcript-focused prompt.
    """
    asset_id = resolve_alias(asset_id)
    if not asset_id:
        return {"found": False, "error": "asset_id required"}
    if not CLIPS_BUCKET_NAME:
        return {"found": False, "error": "CLIPS_BUCKET_NAME not configured"}
    key = f"transcripts/{asset_id}/{asset_id}.json"
    try:
        obj = _s3.get_object(Bucket=CLIPS_BUCKET_NAME, Key=key)
        data = json.loads(obj["Body"].read())
    except _s3.exceptions.NoSuchKey:
        return {"found": False, "asset_id": asset_id, "message": "no transcript on file"}
    except Exception as e:
        return {"found": False, "asset_id": asset_id, "error": f"transcript read failed: {e}"}

    results = (data.get("results") or {})
    language = (
        (results.get("language_identification") or [{}])[0].get("code")
        if isinstance(results.get("language_identification"), list) and results.get("language_identification")
        else data.get("results", {}).get("language_code")
    )
    transcripts = results.get("transcripts") or [{}]
    full_text = " ".join(t.get("transcript", "") for t in transcripts).strip()

    lo = _hhmmss_to_secs(start_time) if start_time else None
    hi = _hhmmss_to_secs(end_time) if end_time else None

    segments: list[dict] = []
    for seg in (results.get("audio_segments") or []):
        try:
            s = float(seg.get("start_time", 0))
            e = float(seg.get("end_time", 0))
        except (TypeError, ValueError):
            continue
        if lo is not None and e < lo:
            continue
        if hi is not None and s > hi:
            continue
        segments.append({
            "start_sec": s,
            "end_sec":   e,
            "text":      (seg.get("transcript") or "").strip(),
        })
        if len(segments) >= max_segments:
            break

    truncated = len(segments) >= max_segments
    return {
        "found":         True,
        "asset_id":      asset_id,
        "language":      language,
        "full_text":     full_text if (lo is None and hi is None) else " ".join(x["text"] for x in segments),
        "segments":      segments,
        "segment_count": len(segments),
        "truncated":     truncated,
    }


@tool
def get_shot_timeline(
    knowledge_store_id: str,
    asset_id: str,
    max_shots: int = 100,
    job_id: Optional[str] = None,
) -> dict:
    """Return the shot cut list for one asset. Cache-first: look up
    `pk=ks#<ks>, sk=SHOTS#<asset_id>` in kb_cache; if present, return
    those shots immediately. On cache miss, kick off a Rekognition
    SegmentDetection job (SHOT segment type) and return
    `{pending: true, job_id, message}` — the caller passes `job_id`
    back on a later turn to poll completion.
    Use whenever the brief or follow-up mentions "shots", "cuts",
    "camera changes", "shot bounds", or needs timecode-precise segment
    boundaries that vector_search's windows don't give.
    Args:
        knowledge_store_id: ks_xxx (needed for the cache key).
        asset_id: 24-char hex.
        max_shots: cap on returned shots (default 100).
        job_id: optional. If provided, poll that in-flight Rekognition
            job instead of starting a new one.
    Returns:
        Cache hit / completed job:
            {status: "complete", asset_id, shots: [{index, start_sec,
            end_sec, duration_sec, start_timecode_smpte, confidence}],
            shot_count, source: "cache"|"rekognition"}.
        Job in flight:
            {status: "pending", job_id, message}.
        Error:
            {status: "error", error}.
    """
    asset_id = resolve_alias(asset_id)
    if not knowledge_store_id or not asset_id:
        return {"status": "error", "error": "knowledge_store_id and asset_id required"}
    if not CLIPS_BUCKET_NAME:
        return {"status": "error", "error": "CLIPS_BUCKET_NAME not configured"}

    # Cache-first.
    cached = _ddb_kb_get(f"ks#{knowledge_store_id}", f"SHOTS#{asset_id}")
    if cached and cached.get("shots"):
        shots = cached.get("shots") or []
        return {
            "status":     "complete",
            "asset_id":   asset_id,
            "shots":      shots[:max_shots],
            "shot_count": min(len(shots), max_shots),
            "source":     "cache",
        }

    rek = _rek_video()

    # Poll an existing job if the caller passed one.
    if job_id:
        try:
            resp = rek.get_segment_detection(JobId=job_id, MaxResults=max_shots)
        except Exception as e:
            return {"status": "error", "error": f"GetSegmentDetection failed: {e}"}
        status = resp.get("JobStatus")
        if status in ("IN_PROGRESS", "QUEUED"):
            return {"status": "pending", "job_id": job_id, "message": f"job {status.lower()}"}
        if status != "SUCCEEDED":
            return {"status": "error", "error": f"job {status}: {resp.get('StatusMessage')}"}
        shots = _parse_segments(resp.get("Segments") or [])
        return {
            "status":     "complete",
            "asset_id":   asset_id,
            "shots":      shots[:max_shots],
            "shot_count": min(len(shots), max_shots),
            "source":     "rekognition",
        }

    # Kick off a new job.
    try:
        resp = rek.start_segment_detection(
            Video={"S3Object": {
                "Bucket": CLIPS_BUCKET_NAME,
                "Name":   f"clips/{asset_id}.mp4",
            }},
            SegmentTypes=["SHOT"],
            Filters={"ShotFilter": {"MinSegmentConfidence": 70.0}},
        )
    except Exception as e:
        return {"status": "error", "error": f"StartSegmentDetection failed: {e}"}
    new_job = resp.get("JobId")
    return {
        "status":  "pending",
        "job_id":  new_job,
        "message": "shot-detection job started — pass job_id back on a later turn to poll",
    }


def _parse_segments(segments: list[dict]) -> list[dict]:
    """Convert Rekognition SegmentDetection segment records into the shape
    the agent returns. Rekognition emits SHOT and TECHNICAL_CUE kinds; we
    keep SHOT only."""
    out: list[dict] = []
    for seg in segments:
        if seg.get("Type") != "SHOT":
            continue
        start_ms = seg.get("StartTimestampMillis") or 0
        end_ms = seg.get("EndTimestampMillis") or 0
        shot_detail = seg.get("ShotSegment") or {}
        out.append({
            "index":                int(shot_detail.get("Index") or len(out)),
            "start_sec":             round(start_ms / 1000.0, 3),
            "end_sec":               round(end_ms / 1000.0, 3),
            "duration_sec":          round((end_ms - start_ms) / 1000.0, 3),
            "start_timecode_smpte":  seg.get("StartTimecodeSMPTE"),
            "confidence":            round(float(shot_detail.get("Confidence") or 0.0), 2),
        })
    out.sort(key=lambda r: r["start_sec"])
    for i, r in enumerate(out):
        r["index"] = i
    return out


_COMPREHEND_MAX_BYTES = 4500


@tool
def get_audio_context(
    asset_id: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
) -> dict:
    """Return a transcript-derived audio-activity timeline for one asset.
    AWS doesn't ship a first-party music/sfx classifier, so this is an
    **approximation**: speech vs. silence buckets come from the Transcribe
    items array (word-level timestamps), and dominant sentiment + named
    mentions come from Comprehend DetectSentiment + DetectEntities on the
    transcript text in the window. Treat the output as a cheap first-pass
    audio sketch; call `pegasus_analyze` with an audio-focused prompt if you
    need true music / sfx / emotion identification.
    Args:
        asset_id: 24-char hex.
        start_time: optional HH:MM:SS lower bound.
        end_time:   optional HH:MM:SS upper bound.
    Returns:
        {found, asset_id, language, speech_segments: [{start_sec, end_sec,
        text}], silence_gaps: [{start_sec, end_sec, duration_sec}],
        dominant_sentiment, sentiment_scores, named_mentions,
        approximation_note}.
    """
    asset_id = resolve_alias(asset_id)
    t = get_transcript(asset_id, start_time=start_time, end_time=end_time)
    if not t.get("found"):
        return {
            "found":              False,
            "asset_id":           asset_id,
            "message":            t.get("message") or t.get("error") or "transcript not available",
        }

    segments: list[dict] = list(t.get("segments") or [])
    text_in_window = " ".join(s.get("text", "") for s in segments).strip() or t.get("full_text") or ""

    # Silence gaps between consecutive speech segments.
    silence_gaps: list[dict] = []
    for prev, cur in zip(segments, segments[1:]):
        gap_s = float(prev.get("end_sec") or 0)
        gap_e = float(cur.get("start_sec") or 0)
        gap_dur = gap_e - gap_s
        if gap_dur >= 1.0:
            silence_gaps.append({
                "start_sec":    gap_s,
                "end_sec":      gap_e,
                "duration_sec": round(gap_dur, 3),
            })

    sentiment = None
    sentiment_scores: dict = {}
    named_mentions: list[dict] = []
    lang = t.get("language") or "en"
    # Comprehend only supports a fixed set of language codes; map accents.
    short_lang = (lang or "en").split("-")[0] if lang else "en"
    if text_in_window:
        clipped = text_in_window.encode("utf-8")[:_COMPREHEND_MAX_BYTES].decode("utf-8", errors="ignore")
        co = _comprehend()
        try:
            s_resp = co.detect_sentiment(Text=clipped, LanguageCode=short_lang)
            sentiment = s_resp.get("Sentiment")
            sentiment_scores = s_resp.get("SentimentScore") or {}
        except Exception as e:
            print(f"get_audio_context: DetectSentiment failed: {e}")
        try:
            e_resp = co.detect_entities(Text=clipped, LanguageCode=short_lang)
            seen: set[str] = set()
            for ent in (e_resp.get("Entities") or []):
                name = (ent.get("Text") or "").strip()
                if not name or name.lower() in seen:
                    continue
                seen.add(name.lower())
                named_mentions.append({
                    "text":  name,
                    "type":  ent.get("Type"),
                    "score": round(float(ent.get("Score") or 0.0), 3),
                })
                if len(named_mentions) >= 50:
                    break
        except Exception as e:
            print(f"get_audio_context: DetectEntities failed: {e}")

    return {
        "found":              True,
        "asset_id":           asset_id,
        "language":           lang,
        "speech_segments":    segments,
        "silence_gaps":       silence_gaps,
        "dominant_sentiment": sentiment,
        "sentiment_scores":   {k: round(float(v), 3) for k, v in sentiment_scores.items()},
        "named_mentions":     named_mentions,
        "approximation_note":
            "Derived from Transcribe + Comprehend; no music/sfx classification. "
            "For true audio-event identification, call pegasus_analyze with an "
            "audio-focused prompt.",
    }


# ═══ User-scoped long-term memory (manage_memory, save_tref_to_memory) ══════
# Memories are keyed by Cognito `sub`. The runtime decodes the user's access
# token once per turn and stores the resulting user_id in `_user_id_ctx` so
# every tool call during the turn namespaces to the right person. Tools fail
# soft if the token is absent (local smoke tests, legacy chat-lambda path).

import base64 as _base64  # noqa: E402
import contextvars as _contextvars  # noqa: E402
from datetime import datetime as _dt, timezone as _tz  # noqa: E402

_user_id_ctx: _contextvars.ContextVar[Optional[str]] = _contextvars.ContextVar(
    "tl_agentcore_user_id", default=None
)


def _b64url_decode(seg: str) -> bytes:
    """Pad and decode a base64url segment (JWT segments are unpadded)."""
    pad = "=" * (-len(seg) % 4)
    return _base64.urlsafe_b64decode(seg + pad)


def decode_cognito_sub(access_token: Optional[str]) -> Optional[str]:
    """Pull the `sub` claim out of a Cognito JWT without verifying the
    signature. The AgentCore Runtime's customJWTAuthorizer already verified
    the token before the request reached this process, so decoding here is
    just claim extraction, not auth. Returns None on any parse failure —
    callers fall through to a disabled-memory path."""
    if not access_token or not isinstance(access_token, str):
        return None
    try:
        _, payload_seg, _ = access_token.split(".")
        claims = json.loads(_b64url_decode(payload_seg))
    except Exception:
        return None
    sub = claims.get("sub") or claims.get("username")
    return str(sub) if sub else None


def set_user_id_from_token(access_token: Optional[str]) -> Optional[str]:
    """Called once per turn by runtime._stream_events to seed `_user_id_ctx`.
    Returns the decoded user_id (or None) so the caller can log it."""
    user_id = decode_cognito_sub(access_token)
    _user_id_ctx.set(user_id)
    return user_id


def _current_user_id() -> Optional[str]:
    return _user_id_ctx.get()


def _now_iso() -> str:
    return _dt.now(_tz.utc).isoformat(timespec="seconds")


def _ddb_memory_put(user_id: str, memory_id: str, item: dict) -> None:
    """Low-level PutItem onto the memories table. Values are converted into
    AttributeValue form; `data` and `tags` are serialized when present."""
    av: dict = {
        "user_id":    {"S": user_id},
        "memory_id":  {"S": memory_id},
        "kind":       {"S": str(item.get("kind") or "note")},
        "created_at": {"S": str(item.get("created_at") or _now_iso())},
        "updated_at": {"S": str(item.get("updated_at") or _now_iso())},
    }
    if item.get("name"):
        av["name"] = {"S": str(item["name"])}
    if item.get("content"):
        av["content"] = {"S": str(item["content"])}
    if item.get("tags"):
        av["tags"] = {"SS": sorted({str(t) for t in item["tags"] if t})}
    if item.get("data") is not None:
        av["data"] = {"S": json.dumps(item["data"])}
    _ddb.put_item(TableName=MEMORIES_TABLE, Item=av)


def _ddb_memory_delete(user_id: str, memory_id: str) -> None:
    _ddb.delete_item(TableName=MEMORIES_TABLE, Key={
        "user_id":   {"S": user_id},
        "memory_id": {"S": memory_id},
    })


def _ddb_memory_list(user_id: str, limit: int = 50) -> list[dict]:
    out: list[dict] = []
    page: dict | None = None
    while True:
        kwargs: dict = {
            "TableName": MEMORIES_TABLE,
            "KeyConditionExpression": "user_id = :u",
            "ExpressionAttributeValues": {":u": {"S": user_id}},
        }
        if page:
            kwargs["ExclusiveStartKey"] = page
        r = _ddb.query(**kwargs)
        for it in r.get("Items", []):
            obj = _ddb_to_python(it) or {}
            data_s = obj.get("data")
            if isinstance(data_s, str):
                try:
                    obj["data"] = json.loads(data_s)
                except Exception:
                    pass
            out.append(obj)
            if len(out) >= limit:
                return out
        page = r.get("LastEvaluatedKey")
        if not page:
            break
    return out


@tool
def manage_memory(
    action: str,
    content: Optional[str] = None,
    name: Optional[str] = None,
    tags: Optional[list[str]] = None,
    memory_id: Optional[str] = None,
    limit: int = 50,
) -> dict:
    """Create, list, or delete the user's long-term memories. Memories persist
    across sessions and are the right place to stash things the producer tells
    you to remember — stylistic preferences, named asset references, running
    notes for a project. **Use whenever the user says "remember that…",
    "save this as…", "forget the note about…", or asks what you have on
    file.** Namespaced per Cognito user; one user's memories are never
    visible to another.
    For named clip references (asset_id + timecodes), prefer `save_tref_to_memory`
    instead — it enforces the TRef shape.
    Args:
        action: "create" (new memory, requires `content`), "list" (returns the
            user's memories, newest first), or "delete" (requires `memory_id`).
        content: free-text body for a `create` action.
        name: optional short handle so a memory can be referenced later
            ("my favorite cold-open", "aspect-ratio preference").
        tags: optional list of string tags for later filtering.
        memory_id: required for `delete`; from a prior `list` result.
        limit: cap on `list` size (default 50).
    Returns:
        {ok, action, memory_id?, memories?, message?}. `memories` is a list of
        {memory_id, kind, name, content, tags, data, created_at, updated_at}.
    """
    if not MEMORIES_TABLE:
        return {"ok": False, "error": "MEMORIES_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"ok": False, "error": "no authenticated user — memory requires a signed-in session"}

    act = (action or "").lower().strip()
    if act == "create":
        if not content and not name:
            return {"ok": False, "error": "create requires `content` or `name`"}
        mid = f"mem_{_uuid.uuid4().hex[:16]}"
        now = _now_iso()
        item = {
            "kind":       "note",
            "name":       name,
            "content":    content,
            "tags":       list(tags) if tags else None,
            "created_at": now,
            "updated_at": now,
        }
        try:
            _ddb_memory_put(user_id, mid, item)
        except Exception as e:
            return {"ok": False, "error": f"memory put failed: {e}"}
        return {"ok": True, "action": "create", "memory_id": mid}

    if act == "list":
        try:
            memories = _ddb_memory_list(user_id, limit=limit)
        except Exception as e:
            return {"ok": False, "error": f"memory list failed: {e}"}
        memories.sort(key=lambda m: str(m.get("created_at") or ""), reverse=True)
        return {"ok": True, "action": "list", "count": len(memories), "memories": memories}

    if act == "delete":
        if not memory_id:
            return {"ok": False, "error": "delete requires `memory_id`"}
        try:
            _ddb_memory_delete(user_id, memory_id)
        except Exception as e:
            return {"ok": False, "error": f"memory delete failed: {e}"}
        return {"ok": True, "action": "delete", "memory_id": memory_id}

    return {"ok": False, "error": f"unknown action {action!r} — use create / list / delete"}


@tool
def save_tref_to_memory(
    name: str,
    asset_id: str,
    start_time: str,
    end_time: str,
    knowledge_store_id: Optional[str] = None,
    notes: Optional[str] = None,
) -> dict:
    """Save a named clip reference (TRef) to the user's long-term memory.
    A TRef = (asset_id, start_time, end_time) — the smallest addressable
    clip the agent emits. Use whenever the producer wants to park a clip
    for later ("save this as 'intro shot'", "remember that cutaway as
    'reaction B'"). The saved TRef can be recalled by `manage_memory(action="list")`.
    Args:
        name: short handle the producer will use to refer back ("intro shot").
        asset_id: 24-char hex, from the current plan or a prior tool result.
        start_time: HH:MM:SS, same format vector_search emits.
        end_time:   HH:MM:SS.
        knowledge_store_id: ks_xxx the clip belongs to (optional but recommended).
        notes: optional one-line description — why this clip, framing cue, etc.
    Returns:
        {ok, memory_id, name, data} on success. The `data` field is the
        saved TRef object.
    """
    if not MEMORIES_TABLE:
        return {"ok": False, "error": "MEMORIES_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"ok": False, "error": "no authenticated user — memory requires a signed-in session"}
    asset_id = resolve_alias(asset_id)
    if not (name and asset_id and start_time and end_time):
        return {"ok": False, "error": "name, asset_id, start_time, end_time are required"}

    mid = f"tref_{_uuid.uuid4().hex[:16]}"
    now = _now_iso()
    data = {
        "asset_id":           asset_id,
        "start_time":         start_time,
        "end_time":           end_time,
        "knowledge_store_id": knowledge_store_id,
        "notes":              notes,
    }
    item = {
        "kind":       "tref",
        "name":       name,
        "content":    notes,
        "data":       data,
        "tags":       ["tref"],
        "created_at": now,
        "updated_at": now,
    }
    try:
        _ddb_memory_put(user_id, mid, item)
    except Exception as e:
        return {"ok": False, "error": f"tref put failed: {e}"}
    return {"ok": True, "memory_id": mid, "name": name, "data": data}


# ═══ Artifact store (save_artifact / open_artifact / list_artifacts) ════════
# Durable, per-user, agent-callable storage for artifacts the producer may
# want to open later: saved EDL plans, generated html-1 apps, rendered
# videos, arbitrary blobs. Small payloads (<16 KiB) ride inline in DDB;
# larger payloads land in the clips bucket under
# `artifacts/<user_id>/<artifact_id>/<name>` with only the s3_key stored in
# the row. Namespaced by Cognito `sub` via the per-turn user_id ContextVar
# that PR #4 introduced.

_ARTIFACT_INLINE_LIMIT_BYTES = 16 * 1024  # 16 KiB — well under DDB's 400 KiB item cap
_ARTIFACT_LIST_LIMIT = 100
_ARTIFACT_PRESIGN_TTL_SEC = 3600  # 1 h

# Catalog of well-known artifact kinds. Agents can save any string, but the
# documented kinds get first-class treatment in the UI/follow-ups:
#   edl.plan     — a saved <plan>...</plan> JSON (from a RoughCut turn)
#   html.app     — a self-contained HTML page (future: generate_html_app)
#   video.render — a MediaConvert-rendered mp4 (future: generate_video,
#                  typically only the s3_key — bytes stay in the clips bucket)
#   other        — free-form; agent explains what it is in `name`/`tags`
_ARTIFACT_KNOWN_KINDS = {"edl.plan", "html.app", "video.render", "other"}


def _artifacts_s3_key(user_id: str, artifact_id: str, name: str) -> str:
    safe_name = _re.sub(r"[^A-Za-z0-9._-]+", "_", name or "artifact")[:120] or "artifact"
    return f"artifacts/{user_id}/{artifact_id}/{safe_name}"


def _coerce_content_bytes(content: object) -> tuple[bytes, str]:
    """Turn whatever the caller handed us into (bytes, content_type).
    Dicts/lists become compact JSON; strings become UTF-8; bytes pass through."""
    if content is None:
        return b"", "application/octet-stream"
    if isinstance(content, bytes):
        return content, "application/octet-stream"
    if isinstance(content, (dict, list)):
        return json.dumps(content, separators=(",", ":")).encode("utf-8"), "application/json"
    return str(content).encode("utf-8"), "text/plain; charset=utf-8"


def _ddb_artifact_item(row: dict) -> dict:
    """Normalize an artifact row for return (parse inline JSON when kind suggests it)."""
    out = dict(row)
    inline = out.get("inline_data")
    if isinstance(inline, str) and inline:
        # Try to parse JSON for the known json-shaped kinds (edl.plan).
        kind = str(out.get("kind") or "")
        if kind == "edl.plan":
            try:
                out["data"] = json.loads(inline)
            except Exception:
                out["data"] = inline
        else:
            out["data"] = inline
    return out


@tool
def save_artifact(
    name: str,
    kind: str,
    content: Optional[object] = None,
    s3_key: Optional[str] = None,
    knowledge_store_id: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> dict:
    """Save a durable artifact to the user's artifact store. Use whenever
    the producer wants to keep something the agent produced for later
    reference: a saved EDL plan, a generated html-1 app, a rendered video
    (pass `s3_key` only — the bytes are already in the clips bucket), or
    any other blob worth persisting. Namespaced per Cognito user; another
    user cannot open or list this artifact.
    Small `content` (<16 KiB) is stored inline in DDB; larger `content`
    is uploaded to `s3://CLIPS_BUCKET/artifacts/<user_id>/<artifact_id>/
    <safe_name>`. Callers who already have an S3 object (e.g. a
    MediaConvert output) should pass `s3_key` directly and omit `content`.
    Args:
        name: short human label ("rough cut v3", "campaign dashboard").
        kind: one of `edl.plan`, `html.app`, `video.render`, `other`.
            Agents may save other strings but the four above get first-
            class UI/tool treatment.
        content: inline payload. str → stored as text, dict/list → JSON,
            bytes → raw. Omit when passing `s3_key`.
        s3_key: pre-existing key under CLIPS_BUCKET to register instead
            of uploading. Must start with "artifacts/" or point at a
            path the user owns.
        knowledge_store_id: ks_xxx the artifact relates to, optional.
        tags: optional list of string tags for later filtering.
    Returns:
        {ok, artifact_id, kind, name, size_bytes, inline, s3_key?}.
        `inline=True` → payload lives in DDB; False → in S3.
    """
    if not ARTIFACTS_TABLE:
        return {"ok": False, "error": "ARTIFACTS_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"ok": False, "error": "no authenticated user — artifact store requires a signed-in session"}
    if not name:
        return {"ok": False, "error": "name required"}
    if not kind:
        return {"ok": False, "error": "kind required (edl.plan, html.app, video.render, other)"}
    if content is None and not s3_key:
        return {"ok": False, "error": "pass `content` or `s3_key`"}

    aid = f"art_{_uuid.uuid4().hex[:16]}"
    now = _now_iso()
    s3_key_out: Optional[str] = s3_key
    inline_data: Optional[str] = None
    size_bytes = 0

    if content is not None:
        body, ctype = _coerce_content_bytes(content)
        size_bytes = len(body)
        if size_bytes <= _ARTIFACT_INLINE_LIMIT_BYTES:
            try:
                inline_data = body.decode("utf-8")
            except UnicodeDecodeError:
                # Non-text payload at tiny size — base64 it and tag.
                inline_data = "b64:" + _base64.b64encode(body).decode("ascii")
        else:
            if not CLIPS_BUCKET_NAME:
                return {"ok": False, "error": "CLIPS_BUCKET_NAME not configured for large artifact upload"}
            s3_key_out = _artifacts_s3_key(user_id, aid, name)
            try:
                _s3.put_object(
                    Bucket=CLIPS_BUCKET_NAME,
                    Key=s3_key_out,
                    Body=body,
                    ContentType=ctype,
                )
            except Exception as e:
                return {"ok": False, "error": f"artifact S3 put failed: {e}"}

    av: dict = {
        "user_id":     {"S": user_id},
        "artifact_id": {"S": aid},
        "kind":        {"S": kind},
        "name":        {"S": name},
        "created_at":  {"S": now},
        "updated_at":  {"S": now},
        "size_bytes":  {"N": str(size_bytes)},
    }
    if inline_data is not None:
        av["inline_data"] = {"S": inline_data}
    if s3_key_out:
        av["s3_key"] = {"S": s3_key_out}
    if knowledge_store_id:
        av["knowledge_store_id"] = {"S": knowledge_store_id}
    if tags:
        av["tags"] = {"SS": sorted({str(t) for t in tags if t})}
    try:
        _ddb.put_item(TableName=ARTIFACTS_TABLE, Item=av)
    except Exception as e:
        return {"ok": False, "error": f"artifact row put failed: {e}"}

    return {
        "ok":          True,
        "artifact_id": aid,
        "kind":        kind,
        "name":        name,
        "size_bytes":  size_bytes,
        "inline":      inline_data is not None,
        **({"s3_key": s3_key_out} if s3_key_out else {}),
        **({"known_kind": kind in _ARTIFACT_KNOWN_KINDS}),
    }


@tool
def open_artifact(artifact_id: str, presign_ttl_sec: int = _ARTIFACT_PRESIGN_TTL_SEC) -> dict:
    """Open a saved artifact by id. Returns the inline payload for small
    artifacts; for S3-backed artifacts, returns a short-lived (default 1h)
    presigned HTTPS URL plus the raw s3_key. Only artifacts owned by the
    signed-in user are visible — another user's artifact_id returns
    `{found: False}`.
    Use when the producer says "open the plan I saved as X" or references
    an artifact by name after a prior `list_artifacts` call.
    Args:
        artifact_id: from a prior `save_artifact` or `list_artifacts` result.
        presign_ttl_sec: validity of the returned URL in seconds (default
            3600 = 1 h). Max 86400 (24 h).
    Returns:
        {found, artifact_id, kind, name, size_bytes, inline?, data?,
        s3_key?, url?, created_at, updated_at, tags, knowledge_store_id}.
    """
    if not ARTIFACTS_TABLE:
        return {"found": False, "error": "ARTIFACTS_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"found": False, "error": "no authenticated user"}
    if not artifact_id:
        return {"found": False, "error": "artifact_id required"}

    try:
        r = _ddb.get_item(TableName=ARTIFACTS_TABLE, Key={
            "user_id":     {"S": user_id},
            "artifact_id": {"S": artifact_id},
        })
    except Exception as e:
        return {"found": False, "error": f"artifact get failed: {e}"}
    item = _ddb_to_python(r.get("Item"))
    if not item:
        return {"found": False, "artifact_id": artifact_id}

    out = _ddb_artifact_item(item)
    out["found"] = True
    s3_key = item.get("s3_key")
    if s3_key:
        ttl = max(60, min(int(presign_ttl_sec or _ARTIFACT_PRESIGN_TTL_SEC), 86400))
        try:
            url = _s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": CLIPS_BUCKET_NAME, "Key": s3_key},
                ExpiresIn=ttl,
            )
            out["url"] = url
            out["url_ttl_sec"] = ttl
        except Exception as e:
            out["url_error"] = f"presign failed: {e}"
    return out


@tool
def list_artifacts(
    kind: Optional[str] = None,
    tag: Optional[str] = None,
    limit: int = 50,
) -> dict:
    """List the signed-in user's artifacts, newest first. Optional filters
    by `kind` (uses the by-kind GSI — faster than a client-side filter)
    and `tag` (client-side substring match on the SS attribute).
    Args:
        kind: optional (edl.plan / html.app / video.render / other / any
            custom string the agent has saved).
        tag: optional case-sensitive match against the artifact's tags.
        limit: max rows (default 50, hard cap 100).
    Returns:
        {ok, count, artifacts: [{artifact_id, kind, name, size_bytes,
        inline (bool), s3_key?, knowledge_store_id?, tags, created_at,
        updated_at}]}.
    """
    if not ARTIFACTS_TABLE:
        return {"ok": False, "error": "ARTIFACTS_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"ok": False, "error": "no authenticated user"}
    hard_limit = max(1, min(int(limit or 50), _ARTIFACT_LIST_LIMIT))

    try:
        if kind:
            r = _ddb.query(
                TableName=ARTIFACTS_TABLE,
                IndexName="by-kind",
                KeyConditionExpression="user_id = :u AND kind = :k",
                ExpressionAttributeValues={":u": {"S": user_id}, ":k": {"S": kind}},
                Limit=hard_limit * 2,  # fetch some headroom for the tag post-filter
            )
        else:
            r = _ddb.query(
                TableName=ARTIFACTS_TABLE,
                KeyConditionExpression="user_id = :u",
                ExpressionAttributeValues={":u": {"S": user_id}},
                Limit=hard_limit * 2,
            )
    except Exception as e:
        return {"ok": False, "error": f"artifact list failed: {e}"}

    rows: list[dict] = []
    for it in r.get("Items", []):
        obj = _ddb_to_python(it) or {}
        if tag and tag not in (obj.get("tags") or []):
            continue
        rows.append({
            "artifact_id":        obj.get("artifact_id"),
            "kind":               obj.get("kind"),
            "name":               obj.get("name"),
            "size_bytes":         obj.get("size_bytes"),
            "inline":             bool(obj.get("inline_data")),
            "s3_key":             obj.get("s3_key"),
            "knowledge_store_id": obj.get("knowledge_store_id"),
            "tags":               obj.get("tags") or [],
            "created_at":         obj.get("created_at"),
            "updated_at":         obj.get("updated_at"),
        })
        if len(rows) >= hard_limit:
            break
    rows.sort(key=lambda m: str(m.get("created_at") or ""), reverse=True)
    return {"ok": True, "count": len(rows), "artifacts": rows}


# ═══ Jockey-parity surface additions (wave 2, PR #3) ═══════════════════════
# Four tools that round out Jockey's MCP surface. All are additive — no new
# tables, no new IAM grants — because they ride on the already-provisioned
# artifacts / kb_cache tables and the existing clips bucket presign flow.

@tool
def render(artifact_id: str, ttl_sec: int = 3600) -> dict:
    """Return a user-facing render URL for a saved artifact: a presigned
    HTTPS URL that opens the raw bytes in a browser, with no agent-side
    JSON wrapper. Prefer this over `open_artifact` whenever the user asks
    for "a link I can click/share" — `open_artifact` is for the agent to
    inspect the payload; `render` is for the user to view it.
    Inline artifacts (<16 KiB) come back as a `data:` URI so the UI can
    embed them without a round-trip. S3-backed artifacts come back as a
    short-lived presigned URL.
    Args:
        artifact_id: from a prior `save_artifact` or `list_artifacts`.
        ttl_sec: validity of the URL (default 3600 = 1 h, max 86400).
    Returns:
        {found, artifact_id, kind, name, url, url_ttl_sec?, is_inline}.
        Not found → {found: False, artifact_id}.
    """
    if not ARTIFACTS_TABLE:
        return {"found": False, "error": "ARTIFACTS_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"found": False, "error": "no authenticated user"}
    if not artifact_id:
        return {"found": False, "error": "artifact_id required"}
    try:
        r = _ddb.get_item(TableName=ARTIFACTS_TABLE, Key={
            "user_id":     {"S": user_id},
            "artifact_id": {"S": artifact_id},
        })
    except Exception as e:
        return {"found": False, "error": f"artifact get failed: {e}"}
    item = _ddb_to_python(r.get("Item"))
    if not item:
        return {"found": False, "artifact_id": artifact_id}

    kind = item.get("kind")
    name = item.get("name")
    s3_key = item.get("s3_key")
    inline = item.get("inline_data")
    if s3_key:
        ttl = max(60, min(int(ttl_sec or 3600), 86400))
        try:
            url = _s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": CLIPS_BUCKET_NAME, "Key": s3_key},
                ExpiresIn=ttl,
            )
        except Exception as e:
            return {"found": True, "artifact_id": artifact_id, "error": f"presign failed: {e}"}
        return {"found": True, "artifact_id": artifact_id, "kind": kind,
                "name": name, "url": url, "url_ttl_sec": ttl, "is_inline": False}
    if inline is not None:
        # Build a data: URI so the frontend can embed without a fetch.
        # inline is either raw UTF-8 text or a "b64:" prefix for binary.
        ctype = "text/html" if kind == "html.app" else (
            "application/json" if kind == "edl.plan" else "text/plain")
        if isinstance(inline, str) and inline.startswith("b64:"):
            b64 = inline[4:]
        else:
            b64 = _base64.b64encode(str(inline).encode("utf-8")).decode("ascii")
        data_uri = f"data:{ctype};base64,{b64}"
        return {"found": True, "artifact_id": artifact_id, "kind": kind,
                "name": name, "url": data_uri, "is_inline": True}
    return {"found": True, "artifact_id": artifact_id, "kind": kind,
            "name": name, "error": "artifact has neither inline_data nor s3_key"}


@tool
def manage_artifacts(
    artifact_id: str,
    action: str,
    new_name: Optional[str] = None,
    add_tags: Optional[list[str]] = None,
    remove_tags: Optional[list[str]] = None,
) -> dict:
    """Mutate an existing artifact — rename it, delete it, or edit its tag
    list. Only the signed-in user's own artifacts are reachable.
    Args:
        artifact_id: from `list_artifacts`.
        action: one of `rename` (requires `new_name`), `delete`
            (removes the DDB row AND the S3 object if any), `tag`
            (applies `add_tags` and/or `remove_tags`).
        new_name: for `rename`. Ignored for other actions.
        add_tags / remove_tags: for `tag`. Both optional; empty = no-op.
    Returns:
        {ok, artifact_id, action, name?, tags?}.
    """
    if not ARTIFACTS_TABLE:
        return {"ok": False, "error": "ARTIFACTS_TABLE not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"ok": False, "error": "no authenticated user"}
    if not artifact_id or not action:
        return {"ok": False, "error": "artifact_id and action required"}
    action = action.lower().strip()
    if action not in ("rename", "delete", "tag"):
        return {"ok": False, "error": f"unknown action {action!r} (expected rename|delete|tag)"}

    key = {"user_id": {"S": user_id}, "artifact_id": {"S": artifact_id}}
    try:
        r = _ddb.get_item(TableName=ARTIFACTS_TABLE, Key=key)
    except Exception as e:
        return {"ok": False, "error": f"artifact get failed: {e}"}
    item = _ddb_to_python(r.get("Item"))
    if not item:
        return {"ok": False, "artifact_id": artifact_id, "error": "not found"}

    now = _now_iso()
    if action == "rename":
        if not new_name:
            return {"ok": False, "error": "new_name required for rename"}
        try:
            _ddb.update_item(
                TableName=ARTIFACTS_TABLE,
                Key=key,
                UpdateExpression="SET #n = :n, updated_at = :u",
                ExpressionAttributeNames={"#n": "name"},
                ExpressionAttributeValues={":n": {"S": new_name}, ":u": {"S": now}},
            )
        except Exception as e:
            return {"ok": False, "error": f"rename failed: {e}"}
        return {"ok": True, "artifact_id": artifact_id, "action": "rename", "name": new_name}

    if action == "delete":
        s3_key = item.get("s3_key")
        try:
            _ddb.delete_item(TableName=ARTIFACTS_TABLE, Key=key)
        except Exception as e:
            return {"ok": False, "error": f"delete failed: {e}"}
        if s3_key and CLIPS_BUCKET_NAME:
            try:
                _s3.delete_object(Bucket=CLIPS_BUCKET_NAME, Key=s3_key)
            except Exception as e:
                # DDB row is gone; log but return ok. The S3 object is a
                # leak but harmless and reclaimable by a sweep job.
                print(f"manage_artifacts: s3 delete failed for {s3_key}: {e}")
        return {"ok": True, "artifact_id": artifact_id, "action": "delete"}

    # action == "tag"
    tags = list(item.get("tags") or [])
    for t in (add_tags or []):
        if t and t not in tags:
            tags.append(t)
    if remove_tags:
        drop = set(remove_tags)
        tags = [t for t in tags if t not in drop]
    try:
        if tags:
            _ddb.update_item(
                TableName=ARTIFACTS_TABLE,
                Key=key,
                UpdateExpression="SET tags = :t, updated_at = :u",
                ExpressionAttributeValues={
                    ":t": {"SS": [str(t) for t in tags]},
                    ":u": {"S": now},
                },
            )
        else:
            # DDB SS can't be empty — remove the attribute instead.
            _ddb.update_item(
                TableName=ARTIFACTS_TABLE,
                Key=key,
                UpdateExpression="REMOVE tags SET updated_at = :u",
                ExpressionAttributeValues={":u": {"S": now}},
            )
    except Exception as e:
        return {"ok": False, "error": f"tag update failed: {e}"}
    return {"ok": True, "artifact_id": artifact_id, "action": "tag", "tags": tags}


@tool
def list_filterable_fields(knowledge_store_id: str) -> dict:
    """Introspect the kb_cache schema and return the field names a client
    can filter on when calling `list_kb_assets`, plus the distinct values
    we've seen for each. Lets the UI build real filter dropdowns instead
    of hard-coding option lists.
    Args:
        knowledge_store_id: ks_xxxxxxxx.
    Returns:
        {ok, knowledge_store_id, fields: {<field_name>: [values…]}}.
        Fields are: `mood_tags`, `role_hint`, `visual_style`,
        `primary_subjects`. Values are deduped + sorted.
    """
    if not knowledge_store_id:
        return {"ok": False, "error": "knowledge_store_id required"}
    raw = _ddb_kb_query(f"ks#{knowledge_store_id}", "ASSET#", limit=None)
    buckets: dict[str, set[str]] = {
        "mood_tags": set(),
        "role_hint": set(),
        "visual_style": set(),
        "primary_subjects": set(),
    }
    for r in raw:
        for t in (r.get("mood_tags") or []):
            if t: buckets["mood_tags"].add(str(t))
        for s in (r.get("primary_subjects") or []):
            if s: buckets["primary_subjects"].add(str(s))
        if r.get("role_hint"):
            buckets["role_hint"].add(str(r["role_hint"]))
        if r.get("visual_style"):
            buckets["visual_style"].add(str(r["visual_style"]))
    return {
        "ok": True,
        "knowledge_store_id": knowledge_store_id,
        "fields": {k: sorted(v) for k, v in buckets.items()},
    }


@tool
def feedback(rating: str, response_id: Optional[str] = None, comment: Optional[str] = None) -> dict:
    """Record a user's reaction to the current response. Writes one line to
    the runtime's stdout, which AgentCore captures into CloudWatch Logs
    under the runtime log group — queryable via Logs Insights without
    needing a dedicated table. Lightweight by design.
    Args:
        rating: `up`, `down`, or any short slug the UI wants (`neutral`,
            `wrong`, `great`). Case-insensitive.
        response_id: optional opaque id for the response being rated —
            correlates with `response.created` on the wire.
        comment: optional short free-text note (truncated at 500 chars).
    Returns:
        {ok, rating, response_id?, logged_at}.
    """
    rating_l = str(rating or "").strip().lower()
    if not rating_l:
        return {"ok": False, "error": "rating required"}
    user_id = _current_user_id() or "anonymous"
    now = _now_iso()
    row = {
        "event": "user_feedback",
        "user_id": user_id,
        "rating": rating_l,
        "response_id": response_id,
        "comment": (comment or "")[:500] or None,
        "logged_at": now,
    }
    print(f"[feedback] {json.dumps(row)}")
    return {"ok": True, "rating": rating_l, "response_id": response_id, "logged_at": now}


# ═══ Session scratch — write-only in this release ══════════════════════════
# runtime.py calls persist_session_turn() at the end of each turn with the
# AgentCore session_id, the knowledge_store_id, the user's prompt, and the
# final <plan>...</plan> text (if the response contained one). 7-day TTL via
# `expires_at`. Read-for-resume (previous_response_id) is deferred to the
# follow-up PR that lands after PR #15.

import re as _re  # noqa: E402

_PLAN_TAG_RE = _re.compile(r"<plan>(.*?)</plan>", _re.DOTALL)
_SESSION_TTL_DAYS = 7


def _extract_plan_text(response_text: str) -> Optional[str]:
    if not response_text:
        return None
    m = _PLAN_TAG_RE.search(response_text)
    return m.group(0) if m else None


def persist_session_turn(
    session_id: Optional[str],
    knowledge_store_id: Optional[str],
    prompt: str,
    response_text: str,
    tool_path: Optional[str] = None,
) -> Optional[str]:
    """UpdateItem on the sessions table — increment turn_count and overwrite
    the per-session scratch fields. Returns the session_id on success, None
    on skip (missing config or empty session_id). Fails soft — a session-write
    failure must never break the turn."""
    if not SESSIONS_TABLE or not session_id:
        return None
    now = _now_iso()
    expires_at = int(_dt.now(_tz.utc).timestamp()) + _SESSION_TTL_DAYS * 86400
    plan_text = _extract_plan_text(response_text) or ""
    user_id = _current_user_id()
    try:
        expr = (
            "SET last_updated_at = :u, expires_at = :e, last_prompt = :p, "
            "last_response_text = :r, last_plan_text = :pl, tool_path = :tp"
            + (", knowledge_store_id = :ks" if knowledge_store_id else "")
            + (", user_id = :uid" if user_id else "")
            + " ADD turn_count :one"
        )
        values: dict = {
            ":u":   {"S": now},
            ":e":   {"N": str(expires_at)},
            ":p":   {"S": str(prompt)[:8000]},
            ":r":   {"S": str(response_text)[:40000]},
            ":pl":  {"S": plan_text[:40000]},
            ":tp":  {"S": str(tool_path or "")},
            ":one": {"N": "1"},
        }
        if knowledge_store_id:
            values[":ks"] = {"S": knowledge_store_id}
        if user_id:
            values[":uid"] = {"S": user_id}
        _ddb.update_item(
            TableName=SESSIONS_TABLE,
            Key={"session_id": {"S": session_id}},
            UpdateExpression=expr,
            ExpressionAttributeValues=values,
        )
        return session_id
    except Exception as e:
        print(f"persist_session_turn: write failed for {session_id}: {e}")
        return None


# Wave-2 PR #8 — session index. The runtime writes `user_id` into every
# turn's session row (when a Cognito sub is resolvable), and the sessions
# table carries a `by-user` GSI (HK=user_id, RK=last_updated_at). The
# tool below queries that GSI so the agent can resurface past turns at
# the user's request ("what was I working on yesterday?", "show me my
# last 5 sessions") without the operator standing up a separate API.
#
# Rows surface only for the signed-in user; a Scan is never issued.
# ScanIndexForward=False sorts most-recent-first.
@tool
def list_my_sessions(limit: int = 10) -> dict:
    """List the signed-in user's most recent agent sessions (one row per
    AgentCore session_id). Use this when the user asks what they were
    working on, wants to resume a prior conversation, or asks you to
    show their recent history. Rows carry: `session_id`, `knowledge_store_id`,
    `last_prompt` (truncated preview), `last_updated_at`, `turn_count`,
    `tool_path`. Returns `{"sessions": [...], "count": N}`, or `{"error": "..."}`
    if the index is unconfigured / the user isn't signed in."""
    if not SESSIONS_TABLE:
        return {"error": "sessions table not configured"}
    user_id = _current_user_id()
    if not user_id:
        return {"error": "no signed-in user — list_my_sessions requires an authenticated session"}
    limit = max(1, min(int(limit or 10), 50))
    try:
        r = _ddb.query(
            TableName=SESSIONS_TABLE,
            IndexName="by-user",
            KeyConditionExpression="user_id = :u",
            ExpressionAttributeValues={":u": {"S": user_id}},
            ScanIndexForward=False,  # newest first
            Limit=limit,
        )
    except Exception as e:
        return {"error": f"query failed: {type(e).__name__}: {e}"}
    sessions: list[dict] = []
    for row in r.get("Items", []):
        prompt_preview = row.get("last_prompt", {}).get("S", "")[:200]
        plan_text = row.get("last_plan_text", {}).get("S", "")
        sessions.append({
            "session_id":         row.get("session_id", {}).get("S", ""),
            "knowledge_store_id": row.get("knowledge_store_id", {}).get("S") or None,
            "last_prompt":        prompt_preview,
            "last_updated_at":    row.get("last_updated_at", {}).get("S", ""),
            "turn_count":         int(row.get("turn_count", {}).get("N", "0")),
            "tool_path":          row.get("tool_path", {}).get("S") or None,
            "has_plan":           bool(plan_text),
        })
    return {"sessions": sessions, "count": len(sessions)}


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
    asset_id = resolve_alias(asset_id)
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

## Asset-id handles (`@id_N`)

Tool results sometimes carry asset ids as short handles like `@id_1`, `@id_2` instead of raw 24-hex strings. The handles are a per-turn shortcut: `@id_1` is simply the first asset id the runtime assigned a handle to, `@id_2` the second, etc. You can:
  - **Refer to them in prose** — "the clip at `@id_3`" is fine; the UI expands handles back to real ids before showing them.
  - **Pass them as `asset_id` args** — tools that take `asset_id` accept either shape and resolve the handle internally.
  - **Keep real ids inside `<plan>`** — the runtime expands handles before `<plan>` is parsed, so write whatever is shorter in your reasoning; the plan JSON ends up with real asset ids regardless.

# Tools by speed class — ALWAYS try the fastest path first

## Tier 0 — AWS-native retrieval (S3 Vectors · 200–400 ms)

1. **vector_search(query_text, knowledge_store_id?, k=5)** — multi-modal retrieval over S3 Vectors. Embeds the query via Bedrock-hosted Marengo and runs three parallel ANN queries (visual / audio / transcription), softmax-fused. Returns asset_id + HH:MM:SS timecodes + per-modality score breakdown.
2. **find_by_image(knowledge_store_id, reference_url, k?)** — image-grounded recognition. Hybrid: Rekognition Faces against a per-KS face collection first (best on identity / faces — MRR 0.77 on our eval), then Marengo image-similarity against the clips index as a fallback for queries Rekognition can't answer (profile shots, helmets, non-face entities). Returns ranked asset_ids tagged by source ("rekognition" vs "marengo"). Use when the user provides or names an image they want to match.

## Tier 1 — Cache (DynamoDB · sub-10 ms). **Always start here on a known knowledge_store_id.**

1. **get_kb_overview(knowledge_store_id)** — corpus summary: asset count, dominant moods, visual styles, role distribution, sample titles, entity count. Call this FIRST on any new KS.
2. **list_kb_assets(knowledge_store_id, mood?, role?)** — filtered list of pre-profiled assets with title, one-liner, mood tags, subjects. The right tool for "find me clips that fit a tone/role".
3. **lookup_asset_profile(knowledge_store_id, asset_id)** — single-asset cached digest. Often replaces a pegasus_analyze. (Also exposed as **get_content_profile** — identical payload, Jockey-canonical name.)
4. **find_cached_entity_appearances(knowledge_store_id, entity_name)** — returns asset_ids where a named entity appears, from the kb_cache cross-asset entity graph. Use whenever the user names a person/object/place. Single DDB GetItem.
5. **list_cached_entities(knowledge_store_id, kind?)** — top entities extracted at ingest, sorted by appearance count.
6. **list_kb_events(knowledge_store_id)** — multi-clip events clustered by Claude at ingest. Use for "what storyline spans these clips".
7. **lookup_event(knowledge_store_id, event_id)** — full record for one event with every participating asset_id.

If the cache returns `cached: False` or no matches, fall through to Tier 2.

## Working set / selections

When the user picks clips in the UI, the runtime attaches them as a `selections` array and prepends a one-line `[selections: ...]` marker to the message. Each entry is `{asset_id, start_sec?, end_sec?, knowledge_store_id?}`. The user usually means *these* when they say "this clip", "that moment", "those three". **Tool calls default any missing `asset_id` / `start` / `end` / `knowledge_store_id` from `selections[0]`**, so a bare `zoom_in_video()` or `pegasus_analyze(prompt="…")` works when a selection is active. Pass explicit args to override — they always win.

## On-demand asset registration

**add_media(source, knowledge_store_id, title?)** — register an S3-hosted video object as a new asset in a KS, mid-conversation. Writes an assets DDB row only; this is **register-only**, so `pegasus_analyze` / `zoom_in_video` / `pegasus_segments` work against the new `asset_id` immediately (they read bytes from the S3 key directly) but `vector_search` and `lookup_asset_profile` won't find it until the operator runs the offline ingest batch. Returns `{asset_id, status, note, …}`. Use when the user says "pull in that clip at s3://…".

## Mining plans (saved prompts on a schedule)

A **mining plan** is a saved agent prompt that re-runs on a schedule — for recurring work like "every Monday 9am, find any new tense sports clips added to this KS in the last 24h and draft a 30s rough cut". Four tools:

1. **jockey_save(prompt, knowledge_store_id, schedule_expression, description?)** — writes the plan AND creates its EventBridge Schedule. `schedule_expression` is EventBridge syntax: `rate(1 day)`, `rate(6 hours)`, `cron(0 9 * * ? *)` (every day at 09:00 UTC), or `at(2026-11-01T15:00:00)` for a one-shot. Returns `{plan_id, schedule_arn, status}`.
2. **jockey_list(knowledge_store_id?, limit?)** — list plans, optionally filtered to one KS. Returns `{plans: […]}`. Plans are **KS-scoped** today, not user-scoped — user-level ownership is a follow-up when PR #16's user_id ContextVar lands.
3. **jockey_run(plan_id, wait=True)** — execute a plan immediately (synchronously invokes the mining-run Lambda). Use for ad-hoc re-runs or testing a plan you just saved. Returns `{plan_id, run_id, status, result_preview, tool_path}`.
4. **jockey_list_runs(plan_id, limit?)** — history of a plan's executions, newest first. Returns `{plan_id, runs: […]}` where each run carries `status, started_at, completed_at, result_text, tool_path`. Runs are TTL'd to 30 days.

## Generation tools (HTML app · video · code eval)

Three tools for producing new material from the plan you've already built. Prefer these over writing freeform output in your reply when the user wants a concrete artifact (something to open, play, or hand to another system).

1. **generate_html_app(spec, max_tokens?, temperature?, title?)** — asks Claude Sonnet (same model you're running on) to produce a self-contained single-page HTML application that matches `spec`. The spec should include concrete data and layout intent — "a results browser for these 5 clips: [list]", not "a nice UI". Returns `{html, size_bytes, title, truncated}`. **Does not persist** — chain to `save_artifact(kind="html.app", payload=html)` when PR #18's artifact store merges. `truncated=True` means Claude hit `max_tokens`; bump it and retry.
2. **generate_video(edl_plan)** — renders an EDL plan (same shape you emit in `<plan>…</plan>`) to a playable MP4 via the stitch MediaConvert pipeline. Synchronous invoke: returns `{job_id, status, preview_url, raw}` as soon as the stitch Lambda has submitted the job. The MP4 itself finishes asynchronously at `s3://CLIPS_BUCKET/stitched/<job_id>/` and is served through CloudFront `/stitched/`. Use this when the user says "render me the cut" or "show me the stitched preview".
3. **execute_code(code)** — narrow Python eval for quick arithmetic / list wrangling (e.g. "sum of these clip durations", "which beat has the most alternates"). **Not a general code interpreter**: no imports, no I/O, no network, no attribute access. Only arithmetic, string ops, comparisons, and the standard safe callables (`abs/all/any/bool/dict/divmod/enumerate/filter/float/int/len/list/map/max/min/range/repr/reversed/round/set/sorted/str/sum/tuple/zip`). Snippet can be a single expression or a short block whose last line is an expression. Returns `{result, repr, mode}` or `{error}`. For heavier compute, raise it as a limitation.

## Tier 2 — On-demand grounding (Bedrock Pegasus 1.5 · 3–15 s)

1. **pegasus_analyze(target, prompt, response_schema?, reference_images?, start_time?, end_time?)** — single-clip generation. Reads `s3://CLIPS_BUCKET_NAME/clips/<asset_id>.mp4` directly with the runtime's IAM role. Use ONLY when cached `lookup_asset_profile` doesn't suffice — "what's visibly happening here", "is this shot bright enough", "what's being said". Pass `response_schema` (a JSON Schema dict) to force structured JSON output. Pass `reference_images` (list of URLs or data URIs) to ground the prompt against visual references — e.g. `pegasus_analyze(asset_id, "Does <@ref_0> appear in this clip?", reference_images=[url])`. Images are auto-named `ref_0, ref_1, ...`; the prompt must reference each one via its `<@name>` placeholder (the tool prepends them if you don't). Pass `start_time` / `end_time` (seconds) to bound analysis to a specific window of a long clip instead of ingesting the whole file.
2. **pegasus_segments(target, segment_definitions, start_time?, end_time?)** — chapterize a clip (or a window of a clip). Pegasus auto-segments and fills your fields per segment. Use for "list every shot/beat/chapter with …". Returns `{segments: [{id, start_sec, end_sec, …your fields}], definition_errors: []}`. Pass `start_time`/`end_time` (seconds) to scope segmentation to a window.
3. **zoom_in_video(asset_id, start_sec, end_sec, question?)** — focused wrapper around `pegasus_analyze` that bounds Pegasus to a specific moment of a clip ("what happens at 15–30s", "describe the chase at 1:02–1:18") and returns a structured dict `{asset_id, start_sec, end_sec, duration_sec, text, question}`. Prefer this over a bare `pegasus_analyze(start_time=..., end_time=...)` when the question is about a specific sub-clip window — the dict shape is friendlier for the agent to reason about and the signature is self-documenting.

## Transcript / shot / audio context — single-asset deep inspection

1. **get_transcript(asset_id, start_time?, end_time?)** — cached ASR output from the ingest pipeline (S3 GetObject). Use whenever you need "what's said" / dialogue text. Much cheaper than a `pegasus_analyze` with a transcription prompt. Window filter is HH:MM:SS.
2. **get_shot_timeline(knowledge_store_id, asset_id)** — Rekognition SegmentDetection (SHOT). Cache-first; on miss returns `{pending, job_id}` — pass the job_id back on a later turn to poll. Use for "where are the cuts", "shot bounds for scene 2 clip 1", or when the brief needs timecode-precise segment boundaries that `vector_search`'s coarse windows don't give.
3. **get_audio_context(asset_id, start_time?, end_time?)** — transcript-derived approximation (Transcribe items + Comprehend sentiment/entities). **No music/sfx classifier** — if the brief truly needs music or sound-event identification, prefer `pegasus_analyze` with an audio-focused prompt.

## Long-term memory (DDB · per-user, persists across sessions)

1. **manage_memory(action, content?, name?, tags?, memory_id?, limit?)** — create/list/delete the user's long-term notes. Use whenever the producer says "remember that…", "save this as…", "forget the note about…", or asks what you have on file. One user's memories are never visible to another. Prefer `save_tref_to_memory` for named clip references.
2. **save_tref_to_memory(name, asset_id, start_time, end_time, knowledge_store_id?, notes?)** — park a named clip (TRef) for later. Use when the producer says "save this clip as 'intro shot'" or similar. The saved TRef is callable from a future turn via `manage_memory(action="list")`.

## Artifact store (DDB + S3 · per-user, durable)

1. **save_artifact(name, kind, content?, s3_key?, knowledge_store_id?, tags?)** — persist a durable artifact. Known kinds: `edl.plan` (a saved <plan> JSON), `html.app` (a self-contained HTML page), `video.render` (MediaConvert output — pass `s3_key` only, bytes already in the clips bucket), `other` (free-form). Small payloads inline; large payloads auto-upload to `artifacts/<user_id>/<artifact_id>/<name>`. Use when the producer says "save this as X" after a Rough Cut, when generating an HTML dashboard, or when a video render finishes and should be bookmarked.
2. **open_artifact(artifact_id, presign_ttl_sec?)** — read one artifact by id. Inline payloads return as `data`; S3-backed payloads return a 1h-TTL presigned HTTPS URL plus the raw `s3_key`. Only the owning user can open.
3. **list_artifacts(kind?, tag?, limit?)** — list the user's artifacts, newest first. The `kind` filter uses a GSI (fast); `tag` is a client-side filter on the string set. Use before `open_artifact` when the producer refers to an artifact by name rather than id.

Distinction from `manage_memory` / `save_tref_to_memory`: **memories are short notes and TRefs** the agent should recall when reasoning (prefs, named clips). **Artifacts are produced outputs** the producer owns and may want to open later (full plan JSON, generated HTML, rendered video).

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

   **Corpus-size sanity check.** If the overview reports `asset_count <= 1`, the "variety across different videos" / "cross-asset diversity" style constraints in the brief are UNREACHABLE — you physically cannot draw scenes from multiple assets when there's only one. Call this out explicitly in your one-or-two-sentence prose reply BEFORE emitting the plan (e.g. "Only one video in this KB, so every scene is drawn from the same broadcast — cross-asset variety isn't reachable here; I'll compensate with tighter cross-cut transitions and beat-level variety within the single asset"). Then proceed. Do NOT silently ignore the constraint; do NOT refuse the request. Same-asset adjacency rules (step 7.c) become advisory, not hard, in the single-asset case — annotate every clip's take_note with "single-asset corpus — cross-cut transitions needed".

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

   **Constraint extraction (do this at the same time as beat parsing).** Producers embed negative constraints in the brief with phrases like "avoid X", "no X", "don't include X", "skip X", "not X shots". Extract them into an `avoid_terms` list. Common examples for broadcast sports: "avoid replays", "no crowd shots", "no talking heads", "avoid officiating reviews", "no anthem", "no commercial bumpers", "no slow-motion". These terms drive TWO things in the next steps:
     - **Query rewriting (step 4).** For every `vector_search` call, append a positive counter-modifier that steers the embedding away from the avoided kind. Never emit the raw negation ("not a replay") — vision-language embeddings ignore negation. Instead phrase the positive: "avoid replays" → append "live in-game action, not slow-motion". "no crowd shots" → append "on-field action, players in frame, not stadium wide". "avoid officiating reviews" → append "live gameplay, referee not on-camera". Keep the appended phrase to one clause, 6-12 words.
     - **Post-filter (step 5).** After a `vector_search` returns candidates, before promoting rank-1, check each candidate's cached `one_liner` and `role_hint` from `lookup_asset_profile`. Drop any candidate whose one_liner clearly matches an avoid term ("slow-motion replay", "crowd cheering", "commentary desk", "under review", "national anthem"). Walk down the ranks until you find one that survives the filter. If NO candidate survives, use rank-1 but flag it in the take_note (e.g. "closest available — corpus may be replay-heavy").

4. In a single turn, emit N parallel `list_kb_assets` calls (one per beat's mood). If cache misses, fall through to `vector_search` per missed beat. **When calling `vector_search`, incorporate the `avoid_terms` counter-modifiers from step 3 into the `query_text` for each beat.**

5. For each beat: rank-1 cached/retrieved clip = primary, AFTER the avoid-term post-filter from step 3. For alternates, walk ranks 2..k and pick the first candidate from each NEW asset_id; skip any candidate whose asset_id has already been used as this clip's primary or earlier alternate, AND skip any candidate that fails the avoid-term filter. Target 2-4 alternates, each from a distinct asset_id where possible. Use cached `one_liner` for the `take_note` — only call `pegasus_analyze` if missing.

   **Skip-range sanity check.** The retrieval layer already drops candidates that overlap the Pegasus-tagged `skip_ranges` (replays, crowd shots, officiating reviews, commercial bumpers, pre/post-game). Trust it — but if a scene's take_note describes something that clearly SHOULD have been flagged as a skip range but wasn't (e.g. "crowd cheers as replay plays on jumbotron"), the profile pre-dates the taxonomy expansion — pick a lower-ranked candidate whose take_note is unambiguously live action, and note in the take_note that the corpus profile needs a re-run.

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

    in_process_tools = [
            # Tier 0 — AWS-native retrieval
            vector_search,
            find_by_image,
            # Tier 1 — Cache (kb_cache: per-asset profiles + cross-asset entity graph + event clusters)
            get_kb_overview, list_kb_assets, lookup_asset_profile, get_content_profile,
            find_cached_entity_appearances, list_cached_entities,
            list_kb_events, lookup_event,
            # On-demand asset registration (brings new media into a KS mid-turn)
            add_media,
            # Mining plans (saved prompts on an EventBridge schedule)
            jockey_save, jockey_list, jockey_run, jockey_list_runs,
            # Tier 2 — On-demand grounding via Bedrock Pegasus
            pegasus_analyze, pegasus_segments, zoom_in_video,
            # Wave-2 PR #6: cached question-answer over one asset.
            qa_item,
            # Transcript / shot / audio context (ASR + Rekognition SegmentDetection + Comprehend)
            get_transcript, get_shot_timeline, get_audio_context,
            # Per-user long-term memory (DDB, Cognito-sub namespaced)
            manage_memory, save_tref_to_memory,
            # Session index — resurface the signed-in user's past turns
            # (sessions.by-user GSI, newest-first).
            list_my_sessions,
            # Generation (PR #11): HTML app via Claude, stitched video, safe eval
            generate_html_app, generate_video, execute_code,
            # Hosted web search + citations (wave-2 PR #7). Provider
            # resolved from WEB_SEARCH_PROVIDER; null-by-default so the
            # tool explains itself when unconfigured.
            web_search,
            # Per-user artifact store (saved plans / html-1 apps / rendered videos / blobs)
            save_artifact, open_artifact, list_artifacts,
            # Jockey-parity wave-2 additions: user-facing render URL, bulk
            # artifact mutations, kb_cache schema introspection, lightweight
            # feedback sink.
            render, manage_artifacts, list_filterable_fields, feedback,
            # Ancillary domain stores (rights + audience cohorts) now
            # live as AgentCore Gateway targets — lambda/plugin_rights
            # and lambda/plugin_audience — so the agent discovers them
            # over MCP alongside anything else a customer plugs in.
            # The in-process Python functions below (lookup_rights,
            # list_audiences, lookup_audience) stay in the file for
            # local_run.py and for the migration safety net, but are
            # no longer registered as Strands tools.
    ]

    # ─── Plugin surface — Distribution-Readiness PR 1 ─────────────────
    # When GATEWAY_MCP_URL is set, the runtime also connects to an
    # AgentCore Gateway that aggregates every registered customer data
    # source (gateway targets, managed by the plugins lambda). Tools
    # discovered from the gateway are MERGED into the in-process tool
    # list; on a name collision the in-process tool wins so a customer
    # can't accidentally shadow a built-in. Falls through silently when
    # the gateway isn't configured (local runs, legacy deploys) or no
    # access token was forwarded (background jobs).
    mcp_url = os.environ.get("GATEWAY_MCP_URL")
    mcp_tools: list = []
    if mcp_url and access_token:
        try:
            from strands.tools.mcp import MCPClient
            from mcp.client.streamable_http import streamablehttp_client

            client = MCPClient(lambda: streamablehttp_client(
                url=mcp_url,
                headers={"Authorization": f"Bearer {access_token}"},
            ))
            client.start()
            mcp_tools = client.list_tools_sync()
        except Exception as e:
            # A broken plugin must not kill the whole turn — the agent
            # still works with its in-process tools alone.
            print(f"[plugins] gateway tool discovery failed: {e}", flush=True)
            mcp_tools = []

    builtin_names = {getattr(t, "__name__", str(t)) for t in in_process_tools}
    merged_tools = list(in_process_tools) + [
        t for t in mcp_tools if getattr(t, "tool_name", getattr(t, "__name__", None)) not in builtin_names
    ]

    agent = Agent(
        system_prompt=system_prompt,
        model=MODEL_ID,
        tools=merged_tools,
    )
    mode = f"in-process+mcp({len(mcp_tools)})" if mcp_tools else "in-process"
    return agent, mode
