"""Brave Search API adapter.

Brave's web search endpoint:
  GET https://api.search.brave.com/res/v1/web/search
Headers:
  X-Subscription-Token: <api key>
  Accept: application/json
Query params:
  q, count (max 20), safesearch, country, search_lang

Response shape (web section):
  {"web": {"results": [{"title", "url", "description", "age"? , ...}]}}

Pricing: free tier covers low-volume dev work; paid plans scale with
QPM. Rotate the key by writing a new value to the SSM parameter
`{WEB_SEARCH_API_KEY_SSM_PREFIX}/brave` — the per-process cache
refreshes within WEB_SEARCH_API_KEY_CACHE_TTL_SECONDS.
"""
from __future__ import annotations

import os

import httpx

from .provider import SearchResult, api_key_for

_BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
_TIMEOUT_S = float(os.environ.get("WEB_SEARCH_HTTP_TIMEOUT_SECONDS", "6.0"))


class BraveProvider:
    name = "brave"

    def search(self, query: str, max_results: int) -> list[SearchResult]:
        key = api_key_for("brave")
        if not key:
            raise RuntimeError(
                "brave api key missing — put it at SSM "
                "`{prefix}/brave` as a SecureString"
            )

        # Brave caps `count` at 20; we clamp lower upstream but
        # defensive-code here too.
        count = max(1, min(int(max_results), 20))

        r = httpx.get(
            _BRAVE_URL,
            params={"q": query, "count": count, "safesearch": "moderate"},
            headers={
                "X-Subscription-Token": key,
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
            },
            timeout=_TIMEOUT_S,
        )
        if r.status_code == 401:
            raise RuntimeError("brave: 401 unauthorized (bad or expired key)")
        if r.status_code == 429:
            raise RuntimeError("brave: 429 rate limited")
        if r.status_code >= 400:
            raise RuntimeError(f"brave: HTTP {r.status_code}: {r.text[:200]}")

        payload = r.json()
        web = (payload.get("web") or {}).get("results") or []
        out: list[SearchResult] = []
        for item in web:
            url = item.get("url")
            if not url:
                continue
            result: SearchResult = {
                "title": item.get("title") or "",
                "url": url,
                "snippet": item.get("description") or "",
            }
            # Brave returns `age` as a human string ("2 days ago") and
            # `page_age` as ISO-8601 on some results. Prefer the ISO one.
            if item.get("page_age"):
                result["published_at"] = item["page_age"]
            out.append(result)
        return out
