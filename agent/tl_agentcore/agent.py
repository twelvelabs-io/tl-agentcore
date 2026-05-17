"""Strands Agent definition for the tl-agentcore Rough Cut / Highlight reel demo.

One retrieval primitive: vector_search.
  - Embeds the query phrase through Marengo's text encoder (sync, 512-dim).
  - Queries an S3 Vectors index of Marengo clip embeddings, filtered by
    knowledge_store_id.
  - Returns ranked clips with timecodes. Rank 1 is the primary on each beat;
    ranks 2..k are emitted on the EDL as `alternatives`.

Plus two ancillaries:
  - pegasus_analyze: prose take-note for the chosen primary when its
    similarity score alone does not justify the pick.
  - list_tl_indexes: discovery, skipped once the index is in context.
"""

from __future__ import annotations

import json
import os
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
    "us.anthropic.claude-sonnet-4-6",
)
EMBED_MODEL = os.environ.get("MARENGO_EMBED_MODEL", "marengo3.0")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
VECTOR_BUCKET_NAME = os.environ.get("VECTOR_BUCKET_NAME")
VECTOR_INDEX_NAME = os.environ.get("VECTOR_INDEX_NAME")

_secrets = boto3.client("secretsmanager", region_name=AWS_REGION) if TL_API_KEY_SECRET else None
_s3v = boto3.client("s3vectors", region_name=AWS_REGION)

_cached_key: Optional[str] = None


def _tl_key() -> str:
    """Resolve the TL API key: env var (local) or Secrets Manager (deployed)."""
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


def _embed_text(query_text: str) -> list[float]:
    """Marengo text encoder. Returns a 512-dim float vector."""
    key = _tl_key()
    files = [
        ("text", (None, query_text)),
        ("model_name", (None, EMBED_MODEL)),
    ]
    with httpx.Client(timeout=60) as c:
        r = c.post(f"{TL_BASE_URL}/embed", headers={"x-api-key": key}, files=files)
    if r.status_code >= 400:
        raise RuntimeError(f"Marengo embed failed {r.status_code}: {r.text[:400]}")
    j = r.json()
    seg = ((j.get("text_embedding") or {}).get("segments") or [{}])[0]
    v = seg.get("float") or seg.get("values") or []
    if not v:
        raise RuntimeError(f"Marengo embed returned no vector: {json.dumps(j)[:300]}")
    return v


def _secs_to_hhmmss(s) -> str:
    try:
        s = float(s)
    except Exception:
        return "00:00:00"
    total = max(0, int(round(s)))
    h, rem = divmod(total, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


# ─── Tier 1 — vector retrieval ─────────────────────────────────────────────
@tool
def vector_search(
    query_text: str,
    knowledge_store_id: str,
    k: int = 5,
) -> dict:
    """Ranked clip-level retrieval over the S3 Vectors index of Marengo clip
    embeddings. The agent's single retrieval primitive.

    Embeds `query_text` via Marengo's text encoder, runs ANN on the index
    filtered by `knowledge_store_id`, and returns the top-`k` clips ordered
    by ascending cosine distance (lower = better match).

    Args:
        query_text: natural-language beat phrase (e.g. "kinetic action with
            crowd reaction", "quiet vineyard wide shot"). Keep concise; the
            embedding model handles semantics.
        knowledge_store_id: scope the search to clips belonging to this KS.
        k: how many clips to return (default 5: rank 1 = primary, 2..k =
            alternates).

    Returns:
        Dict with `clips`: ordered list of {asset_id, start_time, end_time,
        rank, distance}. start_time / end_time are HH:MM:SS strings.
    """
    if not query_text:
        return {"error": "query_text is required"}
    if not knowledge_store_id:
        return {"error": "knowledge_store_id is required"}
    if not (VECTOR_BUCKET_NAME and VECTOR_INDEX_NAME):
        return {"error": "VECTOR_BUCKET_NAME / VECTOR_INDEX_NAME not configured"}

    try:
        vec = _embed_text(query_text)
    except Exception as e:
        return {"error": f"embed failed: {e}"}

    try:
        resp = _s3v.query_vectors(
            vectorBucketName=VECTOR_BUCKET_NAME,
            indexName=VECTOR_INDEX_NAME,
            topK=k,
            queryVector={"float32": vec},
            filter={"knowledge_store_id": knowledge_store_id},
            returnDistance=True,
            returnMetadata=True,
        )
    except Exception as e:
        return {"error": f"S3 Vectors query failed: {e}"}

    clips = []
    for i, v in enumerate(resp.get("vectors") or []):
        md = v.get("metadata") or {}
        clips.append({
            "asset_id":   md.get("asset_id"),
            "start_time": _secs_to_hhmmss(md.get("start_sec") or 0),
            "end_time":   _secs_to_hhmmss(md.get("end_sec")   or 0),
            "rank":       i + 1,
            "distance":   v.get("distance"),
        })
    return {"clips": clips, "query": query_text}


# ─── Ancillaries ────────────────────────────────────────────────────────────
@tool
def list_tl_indexes() -> list:
    """List the user's TwelveLabs Marengo indexes. Use when the user names
    an index by name or asks "what's available". Returns id, name, video_count.
    Usually skipped once the agent is invoked with a knowledge_store_id in
    context (vector_search needs no index lookup).
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
def pegasus_analyze(
    target: str,
    prompt: str,
    target_type: str = "asset_id",
    max_tokens: int = 1024,
) -> str:
    """Generate a take-note about a specific clip using Pegasus. Use ONLY
    when the chosen primary clip needs a richer description than the
    similarity score conveys (for example, the producer asked something
    like "what specifically happens at 0:32-0:38 in this clip?").

    Args:
        target: asset_id (KB-side) OR video_id (Marengo index-side).
        prompt: instruction for Pegasus (<=2000 tokens).
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


# ─── System prompt: EDL composer over a Marengo vector index ─────────────────
SYSTEM_PROMPT = """TASK
Compose an Edit Decision List (EDL) from a producer brief plus an active knowledge_store_id, using a single retrieval primitive over a Marengo clip-embedding index. The brief may be a script, a beat list, a treatment, or a one-line request such as "build a 30-second action highlight reel".

INPUTS
The user message contains the brief and a knowledge_store_id supplied as the literal substring `[ks: ks_xxx]`. If `[ks: ks_xxx]` is absent, reply in plain prose asking which knowledge_store_id to operate against; do not guess and do not call tools.

OUTPUT CONTRACT
Reply in exactly two parts, in order:
  (a) one or two sentences of plain-text commentary stating how the brief was decomposed and how confident the top results look,
  (b) a single JSON document matching the SCHEMA below. Strict JSON: no trailing commas, no comments, no markdown fences, no prose after the JSON.

SCHEMA
{
  "title": str,
  "scenes": [
    {
      "scene_id": str,                       // "01", "02", ...
      "scene_name": str,
      "scene_description": str?,             // optional
      "clips": [
        {
          "video_reference": str,            // 24-char hex asset_id from vector_search
          "start_time": str,                 // HH:MM:SS
          "end_time":   str,                 // HH:MM:SS
          "role": "establishing"|"wide"|"medium"|"close-up"|"insert"|"cutaway"|"b-roll"|"hero",
          "take_note": str,                  // one sentence describing fit
          "alternatives": [                  // 2-4 entries: ranks 2..k from the same vector_search response
            {
              "video_reference": str,
              "start_time": str,
              "end_time":   str,
              "rank": int,
              "why_alt": str                 // one phrase justifying the swap
            }
          ]
        }
      ]
    }
  ],
  "total_estimated_duration": str,           // "MM:SS"
  "notes": str
}

CALLABLES
  vector_search(query_text, knowledge_store_id, k=5)
    Returns the k clips closest to query_text in Marengo embedding space, scoped to the supplied KS via metadata filter. Always call with k=5 unless the brief explicitly asks for fewer options. Emit one call per beat, ALL in parallel within a single model turn. From each response: rank 1 -> primary on that beat; ranks 2..k -> alternates on that same beat. Do not redistribute ranks across beats.

  pegasus_analyze(target, prompt)
    Optional. Invoke only when the producer explicitly asked for a description of a specific clip moment that the vector_search rank ordering does not answer. Not part of the default path.

  list_tl_indexes()
    Skip unless the active knowledge_store_id is unrecognized and you need to confirm which Marengo index it belongs to.

PROCEDURE
  1. Parse the brief into N beat phrases (one phrase per intended scene), in narrative order.
  2. In one model turn, emit N vector_search calls in parallel - same knowledge_store_id, k=5 each, query_text = the beat phrase.
  3. For every beat, take rank 1 as the primary clip and ranks 2..k as alternates on that same clip object.
  4. Compose the EDL per the SCHEMA and emit the OUTPUT CONTRACT.

COMPOSITION HEURISTICS
  Beat granularity. Cluster the brief's prose into beat phrases of comparable grain. A four-act treatment yields four beats, not twelve; a single-sentence request like "build the action sequence" should still yield three to six beats so vector_search has multiple seats to fill. If you cannot name a discrete on-screen moment for a beat, do not invent one - merge it with a neighbor.

  Phrase shape. Each beat phrase is a retrieval query, not a director's note. Write it the way you would search a footage library: a concrete sensory verb, the dominant subject, and one tonal modifier. "Quiet vineyard wide" outranks "an establishing shot showing a vineyard". Strip articles, instructions to the model, and stage directions.

  Role assignment is positional. The opening scene draws from establishing, wide, and atmospheric inserts; mid-sequence scenes draw from medium and close-up alternated against each other; the closing scene draws from hero or held shots. The role field is the handle on the cut's shape - choose it from where the clip sits, not from what the search returned.

  Adjacency check (not a search constraint). If two adjacent beats return primaries that look the same in framing or subject, prefer rank 2 on one of them. Repetition across consecutive clips costs more than a marginal similarity-score hit. Apply this as a post-composition pass, not as a per-search filter; vector_search itself only sees one beat at a time.

  take_note as visual evidence. The take_note field is one sentence naming what the rank-1 clip actually shows for the beat - subject plus action plus framing. It is not a justification of the rank, not a description of the brief, and not a defense of the choice. If you cannot describe the visible content in one sentence without speculating, that is a signal to swap to a different rank rather than to invoke pegasus_analyze.

CONSTRAINTS
  - video_reference values must come verbatim from vector_search responses. No filenames, no synthesized identifiers, no Pegasus-side ids.
  - alternates on a clip object are drawn only from the vector_search response that produced its primary.
  - Per-clip duration: between 3 and 30 seconds.
  - Per-scene clip count: between 3 and 5.
  - Full-cut duration: between 30 seconds and 4 minutes.
  - Time fields are HH:MM:SS with three zero-padded components; no SMPTE frame suffix.

EMPTY INDEX
If every vector_search response yields clips: [], do not emit a plan. Reply in plain prose that the embedding index has not been populated for this knowledge_store_id yet, and direct the user to run `scripts/ingest_vectors.py <ks_id>`.
"""


# ─── Build the agent ────────────────────────────────────────────────────────
def build_agent(access_token: Optional[str] = None) -> tuple[Agent, str]:
    """Construct the Strands Agent. Returns (agent, mode) where mode is
    "mcp-gateway" if wired to the AgentCore Gateway, or "in-process" if
    falling back to direct tool calls.
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
        tools=[vector_search, list_tl_indexes, pegasus_analyze],
    )
    return agent, "in-process"
