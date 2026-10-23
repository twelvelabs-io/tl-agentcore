"""Fake third-party API: social sentiment / buzz index.

Stands in for a real "what's the social buzz on this title in this
territory" service (Brandwatch / Sprout / Talkwalker / Parrot
Analytics). The agent plugs this in to rank cleared assets by social
pre-release demand — the second half of the "should I distribute X to
Y" question (box-office is the historical signal; sentiment is the
forward-looking one).

Auth mode: **Basic** — header `Authorization: Basic <base64(user:password)>`.
Hardcoded expected credential: `demo-user:demo-pw`. The Gateway
credential provider stores the base64-encoded body; Gateway prepends
`Basic ` when injecting.

Deployed as a Lambda with a public Function URL (AuthType=NONE at the
URL layer — auth gate lives in this handler).

Endpoints:

  GET /openapi.json                                       — operator-facing schema
  GET /sentiment?title=X&territory=Y                      — `get_sentiment`
  GET /trending?territory=X                               — `get_trending`
"""
import base64
import json
from pathlib import Path

EXPECTED_USER     = "demo-user"
EXPECTED_PASSWORD = "demo-pw"
AUTH_HEADER = "authorization"

# Seed buzz data. Keyed by (title_lower, territory) → stats.
# buzz_index  — 0.0–10.0, our normalized attention metric
# delta_30d   — percent change over last 30 days
# sentiment   — "positive" | "mixed" | "negative"
# sources     — top mention channels
SEED_BY_TITLE = {
    ("big buck bunny",   "DE"): {"buzz_index": 2.3, "delta_30d": -4,  "sentiment": "mixed",    "sources": ["Reddit r/animation", "Twitter"]},
    ("big buck bunny",   "JP"): {"buzz_index": 1.1, "delta_30d":  2,  "sentiment": "positive", "sources": ["Niconico", "Twitter JP"]},
    ("sintel",           "DE"): {"buzz_index": 3.8, "delta_30d": 12,  "sentiment": "positive", "sources": ["Reddit", "YouTube commentary"]},
    ("sintel",           "JP"): {"buzz_index": 2.9, "delta_30d":  5,  "sentiment": "positive", "sources": ["Twitter JP"]},
    ("tears of steel",   "DE"): {"buzz_index": 5.2, "delta_30d": 28,  "sentiment": "positive", "sources": ["Reddit r/scifi", "Mastodon"]},
    ("tears of steel",   "BR"): {"buzz_index": 4.7, "delta_30d": 19,  "sentiment": "positive", "sources": ["Twitter BR"]},
    ("spring",           "JP"): {"buzz_index": 3.3, "delta_30d":  8,  "sentiment": "mixed",    "sources": ["Niconico"]},
    ("the daily dweebs", "US"): {"buzz_index": 6.1, "delta_30d": 42,  "sentiment": "positive", "sources": ["YouTube", "Reddit"]},
}

# Fallback: if we don't know a title but we know the territory, hand back
# a cold-start default — proves the plugin degrades honestly instead of
# fabricating signal.
DEFAULTS_BY_TERRITORY = {
    "DE": {"buzz_index": 1.2, "delta_30d": 0, "sentiment": "mixed",    "sources": ["(no signal — cold start)"]},
    "JP": {"buzz_index": 0.9, "delta_30d": 0, "sentiment": "mixed",    "sources": ["(no signal — cold start)"]},
    "BR": {"buzz_index": 1.4, "delta_30d": 0, "sentiment": "mixed",    "sources": ["(no signal — cold start)"]},
    "US": {"buzz_index": 1.1, "delta_30d": 0, "sentiment": "mixed",    "sources": ["(no signal — cold start)"]},
}


def _reply(status, body, headers=None):
    h = {"content-type": "application/json"}
    if headers: h.update(headers)
    return {"statusCode": status, "headers": h, "body": json.dumps(body)}


def _openapi_schema():
    p = Path(__file__).parent / "openapi.json"
    return json.loads(p.read_text())


def _check_basic(raw: str) -> bool:
    """Validate `Basic <base64>` where the base64 decodes to the
    expected `demo-user:demo-pw`."""
    if not raw.lower().startswith("basic "):
        return False
    enc = raw.split(" ", 1)[1].strip()
    try:
        decoded = base64.b64decode(enc, validate=True).decode("utf-8")
    except Exception:
        return False
    if ":" not in decoded:
        return False
    u, _, p = decoded.partition(":")
    return u == EXPECTED_USER and p == EXPECTED_PASSWORD


def _get_sentiment(args):
    title     = (args.get("title") or "").strip().lower()
    territory = (args.get("territory") or "").strip().upper()
    if not title or not territory:
        return _reply(400, {"error": "title and territory query params are required"})
    hit = SEED_BY_TITLE.get((title, territory))
    if hit:
        return _reply(200, {
            "title":     title,
            "territory": territory,
            "found":     True,
            "source":    "fakeapi-sentiment (demo)",
            **hit,
        })
    fallback = DEFAULTS_BY_TERRITORY.get(territory)
    if fallback:
        return _reply(200, {
            "title":     title,
            "territory": territory,
            "found":     False,
            "source":    "fakeapi-sentiment (demo — title unknown, returning territory cold-start default)",
            **fallback,
        })
    return _reply(200, {
        "title":     title,
        "territory": territory,
        "found":     False,
        "source":    "fakeapi-sentiment (demo)",
        "message":   "No seed data for this (title, territory). Agent should treat sentiment as unknown.",
    })


def _get_trending(args):
    territory = (args.get("territory") or "").strip().upper()
    if not territory:
        return _reply(400, {"error": "territory query param is required"})
    rows = []
    for (title, t), stats in SEED_BY_TITLE.items():
        if t != territory:
            continue
        rows.append({
            "title":      title,
            "buzz_index": stats["buzz_index"],
            "delta_30d":  stats["delta_30d"],
            "sentiment":  stats["sentiment"],
        })
    rows.sort(key=lambda r: (r["buzz_index"], r["delta_30d"]), reverse=True)
    return _reply(200, {
        "territory":  territory,
        "trending":   rows,
        "source":     "fakeapi-sentiment (demo)",
        "method":     "sorted by (buzz_index, delta_30d) descending",
    })


def handler(event, _context):
    http   = (event.get("requestContext") or {}).get("http") or {}
    method = http.get("method", "GET").upper()
    path   = event.get("rawPath") or "/"
    qs     = event.get("queryStringParameters") or {}
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}

    if method == "GET" and path.endswith("/openapi.json"):
        return _reply(200, _openapi_schema())

    raw = (headers.get(AUTH_HEADER) or "").strip()
    if not _check_basic(raw):
        return _reply(401, {
            "error":  "unauthorized",
            "detail": "expected 'Authorization: Basic base64(user:password)' with the configured demo credential",
        })

    if method == "GET" and path.endswith("/sentiment"):
        return _get_sentiment(qs)
    if method == "GET" and path.endswith("/trending"):
        return _get_trending(qs)
    return _reply(404, {"error": f"no route: {method} {path}"})
