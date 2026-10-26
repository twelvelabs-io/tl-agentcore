"""Hosted web search + citations (wave-2 PR #7 of Jockey parity).

Provider-agnostic scaffold. The agent calls one tool — `web_search` —
and the runtime routes to the active provider named in
`WEB_SEARCH_PROVIDER`. Ships with Brave as the default; if another
provider is needed, add an adapter next to `brave.py` and extend
`select_provider()` in `provider.py`.

Options:

  WEB_SEARCH_PROVIDER = "brave"   # default — adapter in brave.py
  WEB_SEARCH_PROVIDER = "none"    # disable — tool returns an error

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
