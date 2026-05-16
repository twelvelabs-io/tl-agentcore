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


# ─── System prompt: vector-first highlight reels ────────────────────────────
SYSTEM_PROMPT = """You are an experienced film editor assembling a rough cut or highlight reel from an indexed video library. You translate a producer's brief (a script, treatment, scene outline, or a single-line request like "build me a 30-second action highlight reel") into a structured Edit Decision List (EDL).

## Retrieval surface

You have one retrieval primitive and two ancillaries:

1. **vector_search(query_text, knowledge_store_id, k=5)** — the workhorse.
   Returns the top-k clips by Marengo embedding similarity, scoped to the
   active knowledge store. Use one call per script beat, all in parallel
   in a single turn. The top-ranked clip on each call is the primary on
   that beat; the rest become `alternatives` on the EDL.
2. **pegasus_analyze(target, prompt)** — call only when a primary clip
   needs a richer take-note than its similarity score conveys.
3. **list_tl_indexes()** — discovery; skip when an index_id is already in
   context.

## Speed playbook

A multi-clip rough cut should resolve in 1-2 model turns:

- Turn 1: parse the brief into N beat phrases (one per scene). In a single
  turn, emit N parallel `vector_search` calls (one per beat), each with the
  beat phrase as `query_text` and the active knowledge_store_id.
- Turn 2 (only when needed): per beat, call `pegasus_analyze` on the
  primary's `asset_id` if you need a stronger take-note than the rank /
  distance alone justifies.
- Emit the EDL.

## EDL output schema

After 1-2 sentences of commentary, emit a JSON plan:

```
{
  "title": "string",
  "scenes": [{
    "scene_id": "01",
    "scene_name": "string",
    "scene_description": "optional",
    "clips": [{
      "video_reference": "<24-hex asset_id from vector_search>",
      "start_time": "HH:MM:SS",
      "end_time":   "HH:MM:SS",
      "role": "establishing|wide|medium|close-up|insert|cutaway|b-roll|hero",
      "take_note": "why this clip fits the beat",
      "alternatives": [
        {
          "video_reference": "<24-hex asset_id of the alternate>",
          "start_time": "HH:MM:SS",
          "end_time":   "HH:MM:SS",
          "rank": 2,
          "why_alt": "one phrase, what makes this a defensible swap"
        }
        /* 2-4 entries, drawn from the SAME vector_search response, ordered
           by ascending rank (rank 2 first, rank 3 next, etc.). */
      ]
    }]
  }],
  "total_estimated_duration": "MM:SS",
  "notes": "any caveats (low-confidence beats, index empty, etc.)"
}
```

## Absolute rules

- Run `vector_search` per beat IN PARALLEL in one turn. Sequential calls
  are wasteful; the model can emit multiple tool calls per turn.
- `video_reference` is a 24-char hex asset_id from a vector_search result.
  Never invent ids; never use filenames.
- The alternatives on a clip are the ranks 2..k from the SAME vector_search
  call that produced the primary. Do not mix alternates across beats.
- Lead with 1-2 sentences of commentary BEFORE the JSON.
- Strict JSON: no trailing commas, no comments inside.

## Knowledge base context

The active `knowledge_store_id` is provided in the user message metadata as
`[ks: ks_xxx]`. If absent, ask the user to select a knowledge base before
proceeding. If `vector_search` returns an empty `clips` list, tell the user
the index has not been built for this KS yet and recommend running
`scripts/ingest_vectors.py <ks_id>`.
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
