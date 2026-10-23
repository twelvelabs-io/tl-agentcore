"""Fake third-party API: box-office intelligence.

Stands in for a real "how do titles perform in this territory"
revenue intelligence service (Comscore / Gower St. / internal
analytics). The agent plugs this in to answer "is this genre worth
distributing to this territory" — the numeric evidence behind
`audience_fit` and the distribution_card summary.

Auth mode: **Bearer** — header `Authorization: Bearer <token>`.
Hardcoded expected token: `demo-box-tok77`. The Gateway credential
provider stores the raw token; Gateway prepends `Bearer ` when
injecting into the outbound header.

Deployed as a Lambda with a public Function URL (AuthType=NONE at the
URL layer — auth gate lives in this handler).

Endpoints:

  GET /openapi.json                                — operator-facing schema
  GET /box_office?territory=X&genre=Y              — `get_box_office`
  GET /top_territories?genre=X                     — `get_top_territories`
"""
import json
from pathlib import Path

EXPECTED_BEARER = "demo-box-tok77"  # fake, hardcoded on purpose.
AUTH_HEADER = "authorization"

# Seed box-office data. Keyed by (territory, genre) → stats. Returned
# verbatim; the agent weaves numbers into prose + card summary.
#
# avg_opening_m   — average opening-week box office in USD millions
# trend           — "up" | "flat" | "down" over the last 4 quarters
# confidence      — 0.0–1.0 — how reliable the signal is for this cell
# notes           — one-line color
SEED = {
    ("DE", "drama"):   {"avg_opening_m": 3.2,  "trend": "up",   "confidence": 0.78, "notes": "Prestige German-language drama performs; dubbed US drama is softer."},
    ("DE", "action"):  {"avg_opening_m": 8.9,  "trend": "flat", "confidence": 0.84, "notes": "Franchise titles are the mode; original-IP action is risky."},
    ("DE", "comedy"):  {"avg_opening_m": 2.1,  "trend": "down", "confidence": 0.69, "notes": "US comedy translates poorly; local-humor driven market."},
    ("JP", "drama"):   {"avg_opening_m": 4.5,  "trend": "up",   "confidence": 0.81, "notes": "Streaming erosion is slower here than in US."},
    ("JP", "action"):  {"avg_opening_m": 11.2, "trend": "up",   "confidence": 0.87, "notes": "Anime-adjacent action over-indexes; Western action still strong."},
    ("JP", "comedy"):  {"avg_opening_m": 1.8,  "trend": "flat", "confidence": 0.63, "notes": "Narrow cultural fit; expect long-tail SVOD over theatrical."},
    ("BR", "drama"):   {"avg_opening_m": 1.9,  "trend": "flat", "confidence": 0.71, "notes": "Telenovela competition caps upside."},
    ("BR", "action"):  {"avg_opening_m": 5.4,  "trend": "up",   "confidence": 0.79, "notes": "Price-sensitive market; dubbed > subtitled."},
    ("BR", "comedy"):  {"avg_opening_m": 3.3,  "trend": "up",   "confidence": 0.75, "notes": "Local-slang comedy over-indexes; dubbed US works."},
    ("US", "drama"):   {"avg_opening_m": 6.1,  "trend": "down", "confidence": 0.88, "notes": "Streaming cannibalization is real; theatrical window narrowing."},
    ("US", "action"):  {"avg_opening_m": 24.3, "trend": "flat", "confidence": 0.92, "notes": "IP-driven; original action struggles to clear awareness bar."},
    ("US", "comedy"):  {"avg_opening_m": 7.8,  "trend": "flat", "confidence": 0.80, "notes": "Mid-budget comedy still works theatrically."},
}


def _reply(status, body, headers=None):
    h = {"content-type": "application/json"}
    if headers: h.update(headers)
    return {"statusCode": status, "headers": h, "body": json.dumps(body)}


def _openapi_schema():
    p = Path(__file__).parent / "openapi.json"
    return json.loads(p.read_text())


def _get_box_office(args):
    territory = (args.get("territory") or "").strip().upper()
    genre     = (args.get("genre") or "").strip().lower()
    if not territory or not genre:
        return _reply(400, {"error": "territory and genre query params are required"})
    hit = SEED.get((territory, genre))
    if not hit:
        return _reply(200, {
            "territory": territory,
            "genre":     genre,
            "found":     False,
            "message":   "No cell in the fake backing table for this (territory, genre). Add one, or treat as low-confidence.",
            "source":    "fakeapi-boxoffice (demo)",
        })
    return _reply(200, {
        "territory": territory,
        "genre":     genre,
        "found":     True,
        "source":    "fakeapi-boxoffice (demo)",
        **hit,
    })


def _get_top_territories(args):
    """Which territories are hottest for a given genre, ranked by
    opening-week average × trend × confidence."""
    genre = (args.get("genre") or "").strip().lower()
    if not genre:
        return _reply(400, {"error": "genre query param is required"})
    rows = []
    trend_bonus = {"up": 1.15, "flat": 1.0, "down": 0.85}
    for (t, g), stats in SEED.items():
        if g != genre:
            continue
        score = stats["avg_opening_m"] * trend_bonus.get(stats["trend"], 1.0) * stats["confidence"]
        rows.append({
            "territory":     t,
            "avg_opening_m": stats["avg_opening_m"],
            "trend":         stats["trend"],
            "confidence":    stats["confidence"],
            "score":         round(score, 2),
            "notes":         stats["notes"],
        })
    rows.sort(key=lambda r: r["score"], reverse=True)
    return _reply(200, {
        "genre":  genre,
        "top":    rows,
        "method": "avg_opening_m × trend_bonus(up=1.15,flat=1.0,down=0.85) × confidence",
        "source": "fakeapi-boxoffice (demo)",
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
    # Gateway injects "Bearer <token>" into the Authorization header.
    # A production plugin would validate the token signature; here we
    # just string-compare the body of the bearer envelope.
    if not raw.lower().startswith("bearer "):
        return _reply(401, {"error": "unauthorized", "detail": "expected 'Authorization: Bearer <token>'"})
    token = raw.split(" ", 1)[1].strip()
    if token != EXPECTED_BEARER:
        return _reply(401, {"error": "unauthorized", "detail": "bearer token mismatch (demo expects the configured value)"})

    if method == "GET" and path.endswith("/box_office"):
        return _get_box_office(qs)
    if method == "GET" and path.endswith("/top_territories"):
        return _get_top_territories(qs)
    return _reply(404, {"error": f"no route: {method} {path}"})
