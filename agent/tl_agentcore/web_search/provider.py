"""Provider interface + null default + SSM API-key fetch.

Each provider implements `search(query, max_results)` and returns a
list of `SearchResult` dicts. The free function `search()` picks the
configured provider, delegates, and shapes the response the tool emits.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Protocol, TypedDict

import boto3  # type: ignore

_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Hard clamp — keeps a bad `max_results` from blowing the model's
# context budget. 10 is enough for any citation-grade query.
MAX_RESULTS_CAP = 10

# Where provider API keys live. Each provider name maps to a SecureString
# at `{PREFIX}/{provider}`. Example: /tl-agentcore/web-search/brave.
_API_KEY_SSM_PREFIX = os.environ.get(
    "WEB_SEARCH_API_KEY_SSM_PREFIX",
    "/tl-agentcore/web-search",
).rstrip("/")

# Per-process API key cache. TTL is short enough that a rotation lands
# within a few minutes without hammering SSM on every tool call.
_API_KEY_TTL_S = int(os.environ.get("WEB_SEARCH_API_KEY_CACHE_TTL_SECONDS", "300"))

_ssm = boto3.client("ssm", region_name=_REGION)
_api_key_cache: dict[str, tuple[float, str | None]] = {}
_api_key_lock = threading.Lock()


class SearchResult(TypedDict, total=False):
    """One citation. `url` is required; the rest are provider-dependent."""
    title: str
    url: str
    snippet: str
    published_at: str  # ISO-8601 when the provider returns a date; else absent
    source: str  # e.g., "brave" — set by the dispatch layer for traceability


class Provider(Protocol):
    """Minimal contract a provider must satisfy."""

    name: str

    def search(self, query: str, max_results: int) -> list[SearchResult]:
        """Return up to `max_results` SearchResult dicts. Must not raise
        for empty results — return []. Must raise a descriptive exception
        for provider-side errors (bad key, rate limit, 5xx) so the tool
        can surface a specific error_code to the user."""
        ...


class NullProvider:
    """Default when WEB_SEARCH_PROVIDER is unset or "none". Returns no
    results and advertises how to configure a real one."""

    name = "none"

    def search(self, query: str, max_results: int) -> list[SearchResult]:  # noqa: ARG002
        return []


def _provider_env() -> str:
    return os.environ.get("WEB_SEARCH_PROVIDER", "none").lower().strip()


def select_provider() -> Provider:
    """Pick the active provider from WEB_SEARCH_PROVIDER. Deferred imports
    on the adapters keep boot cheap when the feature is off."""
    name = _provider_env()
    if name in ("", "none", "null", "off"):
        return NullProvider()
    if name == "brave":
        from .brave import BraveProvider
        return BraveProvider()
    if name == "google_cse":
        from .stubs import GoogleCseProvider
        return GoogleCseProvider()
    if name == "serpapi":
        from .stubs import SerpApiProvider
        return SerpApiProvider()
    # Unknown value shouldn't crash the runtime — surface it as a
    # configuration error through the tool response instead.
    raise ValueError(
        f"unknown WEB_SEARCH_PROVIDER: {name!r} "
        f"(expected one of: none, brave, google_cse, serpapi)"
    )


def api_key_for(provider: str) -> str | None:
    """Fetch and cache the SecureString API key for `provider`. Returns
    None when the parameter is missing — the caller then surfaces a
    clear "not configured" error instead of making a half-baked call."""
    if not provider or provider == "none":
        return None
    now = time.monotonic()
    with _api_key_lock:
        hit = _api_key_cache.get(provider)
        if hit and hit[0] > now:
            return hit[1]

    key = _fetch_api_key(provider)
    with _api_key_lock:
        _api_key_cache[provider] = (now + _API_KEY_TTL_S, key)
    return key


def _fetch_api_key(provider: str) -> str | None:
    name = f"{_API_KEY_SSM_PREFIX}/{provider}"
    try:
        r = _ssm.get_parameter(Name=name, WithDecryption=True)
    except _ssm.exceptions.ParameterNotFound:
        return None
    except Exception as e:
        print(f"web_search: SSM key lookup failed for {name}: {e}")
        return None
    try:
        return r["Parameter"]["Value"]
    except KeyError:
        return None


def search(query: str, max_results: int = 5) -> dict[str, Any]:
    """Run a hosted web search and return a citation-shaped result.

    Return shape (the tool emits this verbatim):
      {"query": str, "provider": str, "results": [SearchResult...],
       "configured": bool, "error"?: str}

    - `configured=False` means WEB_SEARCH_PROVIDER is "none" (or unset).
      The tool is callable so the model doesn't trip on a missing symbol;
      it just gets back an empty result set with the error field set.
    - Any provider exception is caught and reported in `error` with
      `configured=True` so the caller can distinguish "unconfigured"
      from "configured but failed"."""
    q = (query or "").strip()
    if not q:
        return {
            "query": "",
            "provider": _provider_env() or "none",
            "configured": False,
            "results": [],
            "error": "empty query",
        }

    n = min(max(int(max_results or 5), 1), MAX_RESULTS_CAP)

    try:
        provider = select_provider()
    except ValueError as e:
        return {
            "query": q,
            "provider": _provider_env() or "unknown",
            "configured": False,
            "results": [],
            "error": str(e),
        }

    if isinstance(provider, NullProvider):
        return {
            "query": q,
            "provider": "none",
            "configured": False,
            "results": [],
            "error": (
                "web search not configured — set WEB_SEARCH_PROVIDER "
                "to one of: brave, google_cse, serpapi; put the key at "
                f"SSM {_API_KEY_SSM_PREFIX}/<provider>"
            ),
        }

    try:
        results = provider.search(q, n)
    except Exception as e:
        return {
            "query": q,
            "provider": provider.name,
            "configured": True,
            "results": [],
            "error": f"{type(e).__name__}: {e}",
        }

    # Stamp provenance so the model can cite the source in its reply.
    stamped: list[SearchResult] = []
    for r in results[:n]:
        if not isinstance(r, dict) or not r.get("url"):
            continue
        r.setdefault("source", provider.name)
        stamped.append(r)

    return {
        "query": q,
        "provider": provider.name,
        "configured": True,
        "results": stamped,
    }
