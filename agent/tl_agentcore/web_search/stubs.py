"""Provider stubs — Google CSE and SerpAPI. Flip WEB_SEARCH_PROVIDER to
the matching name and flesh out the `search` body when the provider is
picked. Each stub raises NotImplementedError until wired, so a mis-set
env var surfaces as a clear tool error rather than silent empty results.

Wire-up guide for both providers:
  1. Create an API key with the provider's console.
  2. Store it as a SecureString SSM parameter at
     `{WEB_SEARCH_API_KEY_SSM_PREFIX}/{provider_name}`.
  3. Add a brief adapter here (model on BraveProvider in brave.py).
  4. Flip WEB_SEARCH_PROVIDER in infra/runtime.tf and `terraform apply`.
"""
from __future__ import annotations

from .provider import SearchResult


class GoogleCseProvider:
    """Google Programmable Search Engine (Custom Search JSON API).

    Endpoint:
      GET https://www.googleapis.com/customsearch/v1
    Required params:
      key — API key (SSM: `{prefix}/google_cse`)
      cx  — Programmable Search Engine ID (set via WEB_SEARCH_GOOGLE_CX)
      q   — query
      num — 1-10 (CSE caps at 10 per call)

    Response: {"items": [{"title", "link", "snippet", ...}]}

    Note: Google CSE restricts to the sites you configured in the
    Programmable Search console, so the `cx` is as load-bearing as the
    key. Add a WEB_SEARCH_GOOGLE_CX env var to runtime.tf when wiring."""

    name = "google_cse"

    def search(self, query: str, max_results: int) -> list[SearchResult]:
        raise NotImplementedError(
            "google_cse adapter is a stub — implement in web_search/stubs.py "
            "and set WEB_SEARCH_GOOGLE_CX. See the module docstring."
        )


class SerpApiProvider:
    """SerpAPI (serpapi.com) — a scraper over Google / Bing / DuckDuckGo
    with a uniform JSON response.

    Endpoint:
      GET https://serpapi.com/search.json
    Required params:
      api_key — SerpAPI key (SSM: `{prefix}/serpapi`)
      engine  — "google" (default) | "bing" | "duckduckgo"
      q       — query
      num     — results per page

    Response: {"organic_results": [{"title", "link", "snippet", "date"?}]}

    Note: SerpAPI is a paid-only service past the free trial. Confirm
    the plan matches expected tool-call volume before flipping the
    provider env var."""

    name = "serpapi"

    def search(self, query: str, max_results: int) -> list[SearchResult]:
        raise NotImplementedError(
            "serpapi adapter is a stub — implement in web_search/stubs.py. "
            "See the module docstring."
        )
