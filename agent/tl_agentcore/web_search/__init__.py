"""Hosted web search + citations (wave-2 PR #7 of Jockey parity).

Provider-agnostic scaffold. The agent calls one tool — `web_search` —
and the runtime routes to whichever provider the operator has picked
by setting `WEB_SEARCH_PROVIDER`. Ships with a null default so the
tool is callable but obviously unconfigured until a provider is wired.

Pick a provider by setting:

  WEB_SEARCH_PROVIDER = "brave"       # ready adapter (this release)
  WEB_SEARCH_PROVIDER = "google_cse"  # stub — wire up in stubs.py
  WEB_SEARCH_PROVIDER = "serpapi"     # stub — wire up in stubs.py
  WEB_SEARCH_PROVIDER = "none"        # default — tool returns an error

The provider's API key lives in SSM at
`{WEB_SEARCH_API_KEY_SSM_PREFIX}/<provider>` (SecureString).
Ops rotates by writing a new parameter value — no redeploy needed.

Public:
  search(query, max_results) -> dict   # delegate to the active provider
  select_provider() -> Provider        # for testing / introspection
"""
from __future__ import annotations

from .provider import (
    NullProvider,
    Provider,
    SearchResult,
    search,
    select_provider,
)

__all__ = [
    "NullProvider",
    "Provider",
    "SearchResult",
    "search",
    "select_provider",
]
