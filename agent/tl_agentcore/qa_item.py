"""QA-item cache helpers (wave-2 PR #6 of Jockey parity).

Pure helpers so the `qa_item` tool in agent.py stays short.

Cache storage reuses the existing kb_cache table:

  pk = "ks#<knowledge_store_id>"
  sk = "QA#<asset_id>#<hash16>"

where `hash16` is `sha256(f"{modality}|{start}|{end}|{normalized_question}")[:16]`.
That keeps the sub-clip window + modality in the key so differently-
scoped questions over the same asset don't collide, while
`begins_with(sk, "QA#<asset_id>#")` still lists every cached answer
for an asset.

No new table and no new IAM — kb_cache already carries Put/Get/Query
in the runtime role. Row shape:

  {pk, sk, asset_id, knowledge_store_id, question, question_normalized,
   modality, answer, start_sec?, end_sec?, model_id, cached_at}

Public:
  normalize_question(q) -> str
  classify_modality(q) -> "visual" | "audio"
  cache_key(asset_id, modality, question, start, end) -> str
  shape_prompt(modality, question) -> str
  qa_cache_row(...) -> dict      # DDB-shaped Item ready for put_item
  from_cached_row(row) -> dict   # parse a cache hit back into the tool shape
"""
from __future__ import annotations

import hashlib
import re
import time
from typing import Any

# Tokens that bias the auto-classifier toward audio. Kept short and
# high-precision — a close call defaults to visual, which is the common
# case for Pegasus questions.
_AUDIO_TOKENS = {
    "say", "says", "said", "saying", "speak", "speaks", "speaking", "spoken",
    "speech", "dialogue", "dialog", "voice", "voiceover", "narration",
    "narrator", "music", "song", "soundtrack", "lyric", "lyrics",
    "score", "ambience", "ambient", "sfx", "sound", "sounds", "noise",
    "heard", "hear", "audible", "audio",
    "transcript", "mentions", "mentioned",
}

# Explicit visual tokens let the classifier distinguish "sound of their
# footsteps" (audio) from "sound setup" (ambiguous — visual wins by default).
_VISUAL_TOKENS = {
    "see", "seen", "visible", "visibly", "appear", "appears", "appearing",
    "wear", "wears", "wearing", "worn", "color", "colour", "colored",
    "shot", "shots", "frame", "framing", "composition", "scene",
    "action", "movement", "gesture", "pose", "angle", "camera",
    "character", "person", "people", "face", "faces", "clothing",
    "setting", "lighting", "lit", "backdrop", "background",
}

_WORD_RE = re.compile(r"[a-z0-9']+")
_WS_RE = re.compile(r"\s+")


def normalize_question(question: str) -> str:
    """Lowercase + strip + collapse whitespace. The resulting form is
    what gets hashed into the cache key, so "Who is in the frame?"
    and " who is in THE  frame? " collide to the same cache entry."""
    if not isinstance(question, str):
        return ""
    return _WS_RE.sub(" ", question.strip().lower())


def classify_modality(question: str) -> str:
    """Pick a modality from the question text. Returns "visual" or
    "audio". Ties and no-matches default to "visual" since Pegasus
    without an audio hint handles general scene questions well."""
    words = set(_WORD_RE.findall(normalize_question(question)))
    audio_score = len(words & _AUDIO_TOKENS)
    visual_score = len(words & _VISUAL_TOKENS)
    if audio_score > visual_score:
        return "audio"
    return "visual"


def _window_token(start: float | None, end: float | None) -> str:
    if start is None and end is None:
        return "full"
    s = "" if start is None else f"{float(start):.3f}"
    e = "" if end is None else f"{float(end):.3f}"
    return f"{s}-{e}"


def cache_key(
    asset_id: str,
    modality: str,
    question: str,
    start: float | None,
    end: float | None,
) -> str:
    """Build the sort-key form used in kb_cache. Caller supplies the
    partition key separately (ks#<knowledge_store_id>)."""
    norm = normalize_question(question)
    seed = f"{modality}|{_window_token(start, end)}|{norm}"
    h = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]
    return f"QA#{asset_id}#{h}"


# Prefix templates. The Pegasus docstring explicitly recommends a
# modality hint for audio-focused questions, so an "audio" classification
# shapes the prompt to steer the model that way without the agent having
# to re-write the user's question itself.
_AUDIO_PREFIX = (
    "Focus on the audio of this clip (dialogue, narration, music, sound "
    "effects, ambience, pauses). Answer the following question using only "
    "what is audible:"
)
_VISUAL_PREFIX = (
    "Answer the following question about this clip using what is visibly "
    "on-screen (subjects, actions, framing, setting, mood):"
)


def shape_prompt(modality: str, question: str) -> str:
    """Prepend a modality-steering preamble to the user's question so
    Pegasus biases its attention. 'auto' passes the question through
    verbatim — only used when `qa_item` was called with modality='auto'
    and the classifier abstained (not currently reachable, but safe)."""
    q = (question or "").strip()
    if modality == "audio":
        return f"{_AUDIO_PREFIX} {q}"
    if modality == "visual":
        return f"{_VISUAL_PREFIX} {q}"
    return q


def qa_cache_row(
    *,
    asset_id: str,
    knowledge_store_id: str,
    modality: str,
    question: str,
    answer: str,
    start_sec: float | None,
    end_sec: float | None,
    model_id: str,
) -> dict[str, Any]:
    """Return a DDB `Item` dict (AttributeValue form) ready for put_item."""
    pk = f"ks#{knowledge_store_id}"
    sk = cache_key(asset_id, modality, question, start_sec, end_sec)
    item: dict[str, Any] = {
        "pk":                   {"S": pk},
        "sk":                   {"S": sk},
        "asset_id":             {"S": asset_id},
        "knowledge_store_id":   {"S": knowledge_store_id},
        "question":             {"S": question[:4000]},
        "question_normalized":  {"S": normalize_question(question)[:4000]},
        "modality":             {"S": modality},
        "answer":               {"S": (answer or "")[:40000]},
        "model_id":             {"S": model_id},
        "cached_at":            {"S": _iso_now()},
    }
    if start_sec is not None:
        item["start_sec"] = {"N": f"{float(start_sec):.3f}"}
    if end_sec is not None:
        item["end_sec"] = {"N": f"{float(end_sec):.3f}"}
    return item


def from_cached_row(row: dict[str, Any]) -> dict[str, Any]:
    """Decode a kb_cache row (already python-shaped by _ddb_to_python) into
    the response payload shape `qa_item` returns on a cache hit."""
    out = {
        "asset_id":  row.get("asset_id"),
        "question":  row.get("question"),
        "modality":  row.get("modality"),
        "answer":    row.get("answer"),
        "cached":    True,
        "cached_at": row.get("cached_at"),
        "model_id":  row.get("model_id"),
        "source":    "qa_cache",
    }
    for k in ("start_sec", "end_sec"):
        if row.get(k) is not None:
            out[k] = row[k]
    return out


def _iso_now() -> str:
    # Deliberately format inline rather than importing datetime at module
    # top so this helper is cheap enough to call per cache write.
    import datetime as _dt
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def resolve_modality(mode: str | None, question: str) -> str:
    """Normalize the tool's `modality` arg. 'auto' / None / unknown values
    fall through to the keyword classifier."""
    m = (mode or "auto").strip().lower()
    if m in ("visual", "audio"):
        return m
    return classify_modality(question)
