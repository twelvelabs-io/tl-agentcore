"""Strands Agent definition for the tl-agentcore Rough Cut / Highlight reel demo.

Tools, by speed class:

  Tier 1 — kb_cache (DDB, sub-10ms):
    get_kb_overview       corpus summary
    list_kb_assets        filtered asset list
    lookup_asset_profile  single-asset cached digest

  Tier 2 — TwelveLabs primitives (1-10s):
    list_tl_indexes       discover Marengo indexes
    marengo_search        ranked clip-level retrieval (cache-joined when ks_id passed)
    pegasus_analyze       single-video generative analysis

  Tier 3 — managed orchestration (30s-3min):
    ask_jockey            full Jockey /responses (kept for side-by-side comparison)
    ask_followup          continue a Jockey thread

Phase 1: tools call TL/DDB directly (in-process).
Phase 2: same tool surface, exposed through AgentCore Gateway as MCP. Agent
contract doesn't change — only the wiring inside build_agent().
"""

from __future__ import annotations

import os
import re
from typing import Optional

import boto3
import httpx
from strands import Agent, tool

# ─── Configuration via env ──────────────────────────────────────────────────
TL_BASE_URL = os.environ.get("TL_BASE_URL", "https://api.twelvelabs.io/v1.3")
TL_API_KEY_SECRET = os.environ.get("TL_API_KEY_SECRET")
TL_API_KEY = os.environ.get("TL_API_KEY")  # local dev fallback
MODEL_ID = os.environ.get(
    "AGENT_MODEL_ID",
    # Sonnet 4.6 mirrors Jockey's frontier-model class. With kb_cache
    # pre-built, the agent finishes in fewer turns; the per-turn latency
    # hit is offset.
    "us.anthropic.claude-sonnet-4-6",
)
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
KB_CACHE_TABLE = os.environ.get("KB_CACHE_TABLE")

_secrets = boto3.client("secretsmanager", region_name=AWS_REGION) if TL_API_KEY_SECRET else None
_ddb = boto3.client("dynamodb", region_name=AWS_REGION)

_cached_key: Optional[str] = None


def _tl_key() -> str:
    """Resolve the TL API key — env var (local) or Secrets Manager (deployed)."""
    global _cached_key
    if _cached_key:
        return _cached_key
    if TL_API_KEY:
        _cached_key = TL_API_KEY
        return _cached_key
    if not _secrets or not TL_API_KEY_SECRET:
        raise RuntimeError("TL_API_KEY (env) or TL_API_KEY_SECRET (Secrets Manager id) is required")
    r = _secrets.get_secret_value(SecretId=TL_API_KEY_SECRET)
    _cached_key = r["SecretString"]
    return _cached_key


_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


def _translate_vrefs(text: str, ks_id: str) -> str:
    """Jockey emits KS-item ids (ksi_<uuid> minus prefix). The cache + EDL
    layer is keyed by real asset_id. Look each item up, rewrite occurrences
    in text."""
    uuids = list(set(_UUID_RE.findall(text)))
    if not uuids:
        return text
    key = _tl_key()
    mapping: dict[str, str] = {}
    with httpx.Client(timeout=60) as client:
        for u in uuids:
            try:
                r = client.get(
                    f"{TL_BASE_URL}/knowledge-stores/{ks_id}/items/ksi_{u}",
                    headers={"x-api-key": key},
                )
                if r.status_code == 200:
                    j = r.json()
                    if j.get("asset_id"):
                        mapping[u] = j["asset_id"]
            except Exception:
                continue
    if not mapping:
        return text
    return _UUID_RE.sub(lambda m: mapping.get(m.group(0), m.group(0)), text)


# ─── DDB helpers (kb_cache table) ───────────────────────────────────────────

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


def _ddb_to_python(item):
    if item is None:
        return None
    out: dict = {}
    for k, v in item.items():
        out[k] = _ddb_value(v)
    return out


def _ddb_value(v):
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "NULL" in v: return None
    if "L" in v: return [_ddb_value(x) for x in v["L"]]
    if "M" in v: return {k: _ddb_value(x) for k, x in v["M"].items()}
    if "SS" in v: return list(v["SS"])
    if "NS" in v: return [float(x) if "." in x else int(x) for x in v["NS"]]
    return None


# ─── Tier 3 — managed orchestration (Jockey) ────────────────────────────────
@tool
def ask_jockey(knowledge_store_id: str, prompt: str, instructions: Optional[str] = None) -> str:
    """Send a natural-language question to TwelveLabs Jockey, the managed
    video-reasoning agent that has indexed the organization's video library.

    Use sparingly — slow (30s-3min). Kept in the catalog so the demo can
    show a Jockey-vs-AgentCore side-by-side comparison on the same prompt.

    Args:
        knowledge_store_id: TL knowledge-store id (form: ks_xxxxxxxx).
        prompt: the natural-language question to ask Jockey.
        instructions: optional system instructions to append for this call.

    Returns:
        Jockey's grounded answer as text, with `<vref>` tags rewritten to use
        real asset_ids that downstream tools can join on.
    """
    key = _tl_key()
    body: dict = {
        "model": "jockey1.0",
        "knowledge_store_id": knowledge_store_id,
        "input": [{"type": "message", "role": "user", "content": prompt}],
    }
    if instructions:
        body["instructions"] = instructions
    with httpx.Client(timeout=240) as client:
        r = client.post(
            f"{TL_BASE_URL}/responses",
            headers={"x-api-key": key, "content-type": "application/json"},
            json=body,
        )
    if r.status_code >= 400:
        return f"jockey error {r.status_code}: {r.text[:500]}"
    j = r.json()
    chunks: list[str] = []
    for o in j.get("output", []):
        if o.get("type") == "message":
            for c in o.get("content", []):
                if c.get("type") == "output_text":
                    chunks.append(c["text"])
    text = "\n".join(chunks)
    try:
        text = _translate_vrefs(text, knowledge_store_id)
    except Exception:
        pass
    return text


@tool
def ask_followup(knowledge_store_id: str, session_id: str, prompt: str) -> dict:
    """Continue a Jockey thread — cheaper than ask_jockey when the user's
    question is a follow-up and you have a session_id from a prior call.

    Args:
        knowledge_store_id: same KS as the original session.
        session_id: returned in the prior /responses call.
        prompt: the follow-up question.

    Returns:
        Dict with: text (answer), session_id (reusable).
    """
    if not (knowledge_store_id and session_id and prompt):
        return {"error": "knowledge_store_id, session_id, and prompt required"}
    key = _tl_key()
    body = {
        "model": "jockey1.0",
        "knowledge_store_id": knowledge_store_id,
        "session_id": session_id,
        "input": [{"type": "message", "role": "user", "content": prompt}],
    }
    with httpx.Client(timeout=240) as client:
        r = client.post(
            f"{TL_BASE_URL}/responses",
            headers={"x-api-key": key, "content-type": "application/json"},
            json=body,
        )
    if r.status_code >= 400:
        return {"error": f"jockey {r.status_code}: {r.text[:400]}"}
    j = r.json()
    chunks: list[str] = []
    for o in j.get("output") or []:
        if o.get("type") == "message":
            for c in o.get("content") or []:
                if c.get("type") == "output_text":
                    chunks.append(c.get("text", ""))
    text = "\n".join(chunks)
    try:
        text = _translate_vrefs(text, knowledge_store_id)
    except Exception:
        pass
    return {"text": text, "session_id": j.get("session_id") or session_id}


# ─── Tier 2 — TwelveLabs primitives ─────────────────────────────────────────
@tool
def list_tl_indexes() -> list:
    """List the user's TwelveLabs Marengo indexes. Use when the user names
    an index by name or asks "what's available". Returns id, name, video_count.
    """
    key = _tl_key()
    with httpx.Client(timeout=30) as client:
        r = client.get(
            f"{TL_BASE_URL}/indexes",
            headers={"x-api-key": key},
            params={"page_limit": 50},
        )
    if r.status_code >= 400:
        return [{"error": f"TL indexes {r.status_code}: {r.text[:300]}"}]
    out = []
    for x in r.json().get("data", []):
        out.append({
            "index_id":      x.get("_id"),
            "name":          x.get("index_name"),
            "video_count":   x.get("video_count"),
            "duration_sec":  x.get("total_duration"),
            "models":        [m.get("model_name") for m in x.get("models", [])],
        })
    return out


@tool
def marengo_search(
    index_id: str,
    query_text: str,
    search_options: Optional[list] = None,
    page_limit: int = 10,
    group_by: str = "clip",
    knowledge_store_id: Optional[str] = None,
) -> dict:
    """Search a Marengo index for clips matching a natural-language query.

    Args:
        index_id: TL index id (from list_tl_indexes()). Must be a Marengo index.
        query_text: natural-language search query (≤500 tokens).
        search_options: list of modalities to search across; defaults to
            ["visual","audio"]. Other valid: "transcription".
        page_limit: max results (default 10, max 50).
        group_by: "clip" (default — moment-level) or "video" (asset-grouped).
        knowledge_store_id: optional — when provided, each returned clip is
            enriched with the cached profile (title, one_liner, mood_tags,
            role_hint) from kb_cache. **Pass this whenever you have a ks_id** —
            one extra DDB Query saves you N pegasus_analyze calls.

    Returns:
        Dict with `clips` (list of {video_id, start, end, rank, thumbnail_url,
        transcription, user_metadata, [enriched: title, one_liner,
        mood_tags, role_hint]}) and `total_results`. rank=1 = best match.
    """
    if not index_id:
        return {"error": "index_id is required"}
    if not query_text:
        return {"error": "query_text is required"}
    key = _tl_key()
    opts = search_options or ["visual", "audio"]

    files = [("index_id", (None, index_id))]
    for o in opts:
        files.append(("search_options", (None, o)))
    files.append(("query_text", (None, query_text)))
    files.append(("page_limit", (None, str(page_limit))))
    files.append(("group_by", (None, group_by)))

    with httpx.Client(timeout=120) as client:
        r = client.post(
            f"{TL_BASE_URL}/search",
            headers={"x-api-key": key},
            files=files,
        )
    if r.status_code >= 400:
        return {"error": f"marengo {r.status_code}: {r.text[:400]}"}
    j = r.json()
    clips = j.get("data", []) or []

    # Cache-join: enrich each clip with its kb_cache profile when ks_id is given.
    # video_id (index-side) usually maps 1:1 to asset_id (KB-side). A miss is
    # never an error — clip stays un-enriched.
    if knowledge_store_id and KB_CACHE_TABLE and clips:
        try:
            profiles = _ddb_kb_query(f"ks#{knowledge_store_id}", "ASSET#")
            by_id = {p.get("asset_id"): p for p in profiles if p.get("asset_id")}
            for c in clips:
                vid = c.get("video_id") or ""
                p = by_id.get(vid)
                if p:
                    c["enriched"] = {
                        "title":     p.get("title"),
                        "one_liner": p.get("one_liner"),
                        "mood_tags": p.get("mood_tags") or [],
                        "role_hint": p.get("role_hint"),
                    }
        except Exception:
            pass

    return {
        "clips":         clips,
        "total_results": (j.get("page_info") or {}).get("total_results"),
        "index_id":      (j.get("search_pool") or {}).get("index_id"),
    }


@tool
def pegasus_analyze(
    target: str,
    prompt: str,
    target_type: str = "asset_id",
    max_tokens: int = 1024,
) -> str:
    """Generate a text response about a specific video using Pegasus.

    Args:
        target: asset_id (KB-side) OR video_id (Marengo index-side).
        prompt: instruction for Pegasus (≤2000 tokens).
        target_type: "asset_id" (default) or "video_id".
        max_tokens: response cap (1-4096, default 1024).

    Returns:
        Pegasus's grounded text response.
    """
    if not target:
        return "error: target (asset_id or video_id) is required"
    if not prompt:
        return "error: prompt is required"
    key = _tl_key()
    body: dict = {
        "prompt": prompt,
        "stream": False,
        "max_tokens": max_tokens,
    }
    # Marengo /search returns `video_id`, NOT `asset_id`, so pass it via the
    # deprecated top-level field. asset_ids go through the new structured form.
    if target_type == "video_id":
        body["video_id"] = target
    else:
        body["video"] = {"type": "asset_id", "asset_id": target}
    with httpx.Client(timeout=240) as client:
        r = client.post(
            f"{TL_BASE_URL}/analyze",
            headers={"x-api-key": key, "content-type": "application/json"},
            json=body,
        )
    if r.status_code >= 400:
        return f"pegasus {r.status_code}: {r.text[:400]}"
    j = r.json()
    return j.get("data") or "(no text returned)"


# ─── Tier 1 — kb_cache lookups ──────────────────────────────────────────────
@tool
def get_kb_overview(knowledge_store_id: str) -> dict:
    """Return the pre-computed corpus overview for a knowledge store: total
    asset count, dominant moods, dominant visual styles, common roles, and
    a sample of titles. **Call this FIRST on any new knowledge store** —
    DDB GetItem; if the overview is missing (cached: False), fall through
    to list_tl_indexes + marengo_search.

    Returns:
        Dict with: cached (bool), asset_count, top_moods, top_styles,
        top_roles, sample_titles, marengo_index_id.
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
    """List cached assets in a knowledge store, optionally filtered by mood
    or role hint. The cache-first path — prefer this over marengo_search
    when the goal is "find me clips that fit a mood / role".

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        mood: optional case-insensitive partial match against mood_tags
            (e.g. "tension", "action", "release", "coda", "celebration").
        role: optional case-insensitive partial match against role_hint
            (e.g. "cold-open", "action-set-piece", "emotional-coda").
        limit: max assets to return (default 30).

    Returns:
        List of profiles {asset_id, title, one_liner, mood_tags,
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
def lookup_asset_profile(knowledge_store_id: str, asset_id: str) -> dict:
    """Read the cached profile for one asset. Use before pegasus_analyze —
    if the cached one_liner answers the question, skip the live call.

    Args:
        knowledge_store_id: ks_xxxxxxxx.
        asset_id: 24-char hex asset id.

    Returns:
        Dict with cached fields + cached (bool).
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


# ─── System prompt — RoughCut / Highlight focus ─────────────────────────────
SYSTEM_PROMPT = """You are an experienced film editor assembling a rough cut or highlight reel from an indexed video library. You translate a producer's brief — a script, treatment, scene outline, or a single-line request like "build me a 30-second action highlight reel" — into a structured Edit Decision List (EDL).

## Tools by speed class — ALWAYS try the fastest tier first

### Tier 1 — Cache (DDB · sub-10ms). **Always start here on a known knowledge_store_id.**

1. **get_kb_overview(knowledge_store_id)** — corpus summary (asset count, dominant moods, visual styles, role distribution, sample titles, marengo_index_id). Call this FIRST on any new KS.
2. **list_kb_assets(knowledge_store_id, mood?, role?)** — filtered list of pre-profiled assets with title, one_liner, mood_tags, visual_style, role_hint. The right tool for "find me clips that fit a tone or beat".
3. **lookup_asset_profile(knowledge_store_id, asset_id)** — single-asset cached digest. Often replaces a pegasus_analyze.

If the cache is empty (`cached: False`) or returns no matches, fall through to Tier 2.

### Tier 2 — Live primitives (TL API · 1-10s)

4. **marengo_search(index_id, query_text, knowledge_store_id?)** — ranked clip-level retrieval. **Always pass `knowledge_store_id`** when you have it — Marengo returns clips enriched with the cached profile, eliminating most follow-up Pegasus calls.
5. **pegasus_analyze(target, prompt)** — single-video generation. Use ONLY when the cached `lookup_asset_profile` doesn't already answer your question.
6. **list_tl_indexes()** — discover Marengo indexes. Skip when an index_id is already in context (e.g. from `get_kb_overview`).

### Tier 3 — Managed orchestration (TL Jockey · 30s-3min)

7. **ask_jockey(knowledge_store_id, prompt)** — full Jockey orchestration. Kept in the catalog for side-by-side comparison demos. Don't reach for it when Tier 1 + Tier 2 cover the question.
8. **ask_followup(knowledge_store_id, session_id, prompt)** — continue an ask_jockey thread.

## Speed playbook for a multi-clip rough cut

1. `get_kb_overview` (cheap, instant) — see what moods and roles exist, grab the `marengo_index_id`.
2. **Turn 1, parallel fan-out:** one `list_kb_assets` call per beat to scout the cache.
3. **Turn 2, parallel fan-out — REQUIRED:** one `marengo_search(index_id, "<beat phrase>", knowledge_store_id, page_limit=5)` per beat. This runs **even when Turn 1 already gave you a strong primary** — Marengo's ranked output is the source of the per-clip `alternatives` array (see schema below). Producers need to be able to swap any clip for a similarly-ranked option, and Marengo `rank` is the only signal that lets them do that.
4. Use `pegasus_analyze` only when neither cache nor Marengo gave you a usable take-note.

A typical rough cut should resolve in 3 model turns: overview + cache fan-out (Turn 1), Marengo fan-out (Turn 2), emit plan (Turn 3).

## EDL output schema

When the user asks for a rough cut or highlight reel, emit a JSON plan after a 1-2 sentence commentary:

```
{
  "title": "string",
  "scenes": [{
    "scene_id": "01",
    "scene_name": "string",
    "scene_description": "optional",
    "clips": [{
      "video_reference": "<24-hex asset_id from list_kb_assets, or video_id from marengo_search>",
      "start_time": "HH:MM:SS",
      "end_time":   "HH:MM:SS",
      "role": "establishing|wide|medium|close-up|insert|cutaway|b-roll|hero",
      "take_note": "why this clip fits the beat",
      "alternatives": [
        {
          "video_reference": "<24-hex id of the alternate>",
          "start_time": "HH:MM:SS",
          "end_time":   "HH:MM:SS",
          "rank": 2,              // Marengo rank in the same query that produced the primary; 1 = best
          "why_alt": "one phrase, what makes this a defensible swap"
        }
        /* …2-4 entries total, ordered by ascending rank.  Drawn from the
           SAME marengo_search call you used for this beat.  If the primary
           also came from Marengo, omit it from the alternatives list. */
      ]
    }]
  }],
  "total_estimated_duration": "MM:SS",
  "notes": "cache hit/miss count + which moods you mapped to which beats"
}
```

## Time-range defaults when you only have cached assets (no marengo timecodes)

Pick a sensible range based on `role_hint`:
- cold-open / atmospheric / hero-shot → 00:00:00 → 00:00:08
- action-set-piece / kinetic → 00:00:30 → 00:00:38 (action usually starts after the setup)
- emotional-coda / intimacy → 00:01:00 → 00:01:08 (coda beats sit deeper in the asset)
- b-roll / transition → 00:00:10 → 00:00:14 (short cutaway)

If you DID call marengo_search, prefer its actual start/end (clamped to ≤30s).

## Absolute rules

- Prefer cache (Tier 1) for the PRIMARY pick. Most beat primaries should resolve from cache alone.
- Run `marengo_search` per beat REGARDLESS of cache hit — it is the source of the `alternatives` array. This is non-negotiable for highlight-reel and rough-cut tasks.
- Within a single turn, emit ALL parallelizable tool calls at once.
- video_reference is a 24-char hex id (asset_id from cache OR video_id from Marengo). Never invent ids; never use filenames.
- Lead with 1-2 sentences of commentary BEFORE the JSON (mention cache hit/miss + index used).
- Strict JSON: no trailing commas, no comments inside.

## Knowledge base context

The active `knowledge_store_id` is provided in the user message metadata as `[ks: ks_xxx]`. If absent, ask the user to select a knowledge base before proceeding.

## When the cache is empty

If `get_kb_overview` returns `cached: False`, tell the user:
> "This KB doesn't have its profile cache built yet — falling back to live retrieval; expect ~3-5× slower responses. (Run `scripts/ingest_kb_cache.py <ks_id>` to build it.)"
Then proceed with Tier 2 tools.
"""


# ─── Build the agent ────────────────────────────────────────────────────────
def build_agent(access_token: Optional[str] = None) -> tuple[Agent, str]:
    """Construct the Strands Agent. Returns (agent, mode) where mode is
    "mcp-gateway" if wired to the AgentCore Gateway, or "in-process" if
    falling back to direct TL/DDB calls.

    Phase 1 (in-process): agent code holds the tools.
    Phase 2 (mcp-gateway): same tools, served by AgentCore Gateway as MCP.

    A Cognito access_token is required for the MCP path because the Gateway
    uses CUSTOM_JWT auth — we forward the user's identity through.
    """
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
        agent = Agent(system_prompt=SYSTEM_PROMPT, model=MODEL_ID, tools=tools)
        return agent, "mcp-gateway"

    agent = Agent(
        system_prompt=SYSTEM_PROMPT,
        model=MODEL_ID,
        tools=[
            # Tier 1 — cache
            get_kb_overview, list_kb_assets, lookup_asset_profile,
            # Tier 2 — live TL primitives
            list_tl_indexes, marengo_search, pegasus_analyze,
            # Tier 3 — managed (kept for comparison demos)
            ask_jockey, ask_followup,
        ],
    )
    return agent, "in-process"
