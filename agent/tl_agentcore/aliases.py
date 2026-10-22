"""Per-turn ID alias layer (wave-2 PR #4 of Jockey parity).

Problem: a vector_search fanout returns ~25 clips, each with a 24-hex
`asset_id`. At ~24 tokens per id that's ~600 tokens of pure noise in the
agent's context window — repeated every time the ids echo in prose,
tool args, or later tool results. The model also parrots the hex back
in the EDL plan, which can cost another ~300 tokens on a 10-clip plan.

Solution: a short handle per asset id (`@id_1`, `@id_2`, ...), allocated
in insertion order on first sighting and remembered for the rest of the
turn. Tool outputs are rewritten to carry the handle instead of the raw
hex before they go back to the model; tool inputs carrying a handle are
expanded back to the real id before the tool runs; the final prose and
`<plan>` text are expanded on the way out to the UI so clip ids stay
real everywhere outside the model's view.

Public:
  reset_turn_aliases() — call at the top of each turn to zero the map.
  alias_for(asset_id)  — allocate / fetch the handle. Idempotent.
  resolve_alias(s)     — "@id_N" → real asset_id, or s unchanged.
  aliasify_result(obj) — walk a tool-result dict/list and swap known
                         id fields (asset_id/asset_ids/mimir_id) for
                         their handles.
  expand_text(text)    — replace every "@id_N" in the string with the
                         real asset_id for that handle (missing handles
                         pass through unchanged).

ContextVar backing means the map is per-turn and per-task — the runtime
sets a fresh map at the start of each _semantic_stream call and tools
inherit it via the normal asyncio ContextVar propagation.
"""
from __future__ import annotations

import re
from contextvars import ContextVar
from typing import Any

# "@id_<n>" with word-boundary semantics but tolerant of adjacent
# punctuation (`'`, `)`, `,`, `.`), which the model often emits in prose.
_ALIAS_RE = re.compile(r"@id_(\d+)")

# Matches a 24-hex asset id anywhere in a string value. Strict-ish so we
# don't accidentally rewrite a 24-hex substring of a longer token.
_HEX_RE = re.compile(r"\b([0-9a-f]{24})\b")

# DDB / tool-result keys whose string value is a raw 24-hex asset id.
_ID_FIELDS = {"asset_id", "mimir_id"}
# DDB / tool-result keys whose list value is a list of raw 24-hex ids.
_ID_LIST_FIELDS = {"asset_ids", "mimir_ids"}


class _AliasMap:
    """Bidirectional alias ↔ asset_id store. Not thread-safe; one lives
    per task via the ContextVar below."""

    __slots__ = ("_fwd", "_rev", "_n")

    def __init__(self) -> None:
        self._fwd: dict[str, str] = {}
        self._rev: dict[str, str] = {}
        self._n: int = 0

    def alias(self, asset_id: str) -> str:
        if not isinstance(asset_id, str) or not asset_id:
            return asset_id
        hit = self._fwd.get(asset_id)
        if hit is not None:
            return hit
        self._n += 1
        a = f"@id_{self._n}"
        self._fwd[asset_id] = a
        self._rev[a] = asset_id
        return a

    def resolve(self, alias: str) -> str | None:
        return self._rev.get(alias)

    def snapshot(self) -> dict[str, str]:
        """Return a copy of the current {alias: asset_id} map — handy
        for including in session persistence or UI side-channels."""
        return dict(self._rev)


_ctx: ContextVar[_AliasMap | None] = ContextVar("tl_agentcore_aliases", default=None)


def reset_turn_aliases() -> None:
    """Install a fresh alias map on this task. The runtime calls this at
    the top of each _semantic_stream turn."""
    _ctx.set(_AliasMap())


def _get() -> _AliasMap | None:
    return _ctx.get()


def _get_or_init() -> _AliasMap:
    cur = _ctx.get()
    if cur is None:
        cur = _AliasMap()
        _ctx.set(cur)
    return cur


def alias_for(asset_id: str) -> str:
    """Return the handle (`@id_N`) for `asset_id`. Idempotent. Returns
    the input unchanged when it is falsy or not a string."""
    return _get_or_init().alias(asset_id)


def resolve_alias(value: str | Any) -> Any:
    """Expand a bare `@id_N` token to the real asset_id. Non-aliases
    (24-hex ids, None, non-strings, strings that don't match the alias
    shape) pass through unchanged. Used by tools that take `asset_id` as
    a kwarg so the agent can refer to clips by their handles."""
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    m = _ALIAS_RE.fullmatch(stripped)
    if not m:
        return value
    cur = _get()
    if cur is None:
        return value
    real = cur.resolve(stripped)
    return real if real is not None else value


def aliasify_result(obj: Any) -> Any:
    """Recursively walk `obj` and swap known id-field values for their
    handles. Returns a new object; the input is not mutated. Keys left
    as-is are: `asset_id` / `mimir_id` (string → handle),
    `asset_ids` / `mimir_ids` (list[string] → list[handle])."""
    m = _get_or_init()
    return _walk(obj, m, forward=True)


def dealias_dict(obj: Any) -> Any:
    """Inverse of aliasify_result — walk `obj` and swap any `@id_N`
    handles sitting in known id-field positions back to real asset ids.
    Needed by tools that accept nested structures from the agent
    (generate_video(edl_plan=...), save_tref_to_memory batch args) where
    the agent may have carried the handles through from a prior tool
    result. Returns a new object; input not mutated."""
    cur = _get()
    if cur is None:
        return obj
    return _walk(obj, cur, forward=False)


def _walk(obj: Any, m: _AliasMap, *, forward: bool) -> Any:
    def _swap(v: Any) -> Any:
        if not isinstance(v, str):
            return v
        if forward:
            return m.alias(v)
        return m.resolve(v) or v

    if isinstance(obj, dict):
        out: dict = {}
        for k, v in obj.items():
            if k in _ID_FIELDS and isinstance(v, str):
                out[k] = _swap(v)
            elif k in _ID_LIST_FIELDS and isinstance(v, list):
                out[k] = [_swap(x) for x in v]
            else:
                out[k] = _walk(v, m, forward=forward)
        return out
    if isinstance(obj, list):
        return [_walk(x, m, forward=forward) for x in obj]
    return obj


def expand_text(text: str) -> str:
    """Replace every `@id_N` substring in `text` with the corresponding
    real asset_id. Handles the model hasn't seen (or that never got
    allocated) pass through verbatim — safer than erroring and losing
    the response. Used post-stream on `final_text` so the UI and the
    duration enforcer see real asset_ids inside the `<plan>` block."""
    if not text:
        return text
    cur = _get()
    if cur is None:
        return text

    def _one(match: re.Match) -> str:
        a = match.group(0)
        real = cur.resolve(a)
        return real if real is not None else a

    return _ALIAS_RE.sub(_one, text)


def current_snapshot() -> dict[str, str]:
    """{alias: asset_id} map for this turn, or {} when empty.
    Suitable for logging, session persistence, or a UI debug panel."""
    cur = _get()
    return cur.snapshot() if cur else {}
