"""Fake third-party API: deliverables inventory.

Stands in for a real "what artifacts does this asset actually have"
inventory system (Mediator / Imagica / internal MAM / etc.). The agent
plugs this in to fill the `have` field on each asset in the
<distribution_card>, instead of defaulting to just ["video"].

Auth mode: **API key** — header `X-API-Key`. Hardcoded here as
`demo-del-k9x2` so the point-of-the-exercise ("prove Gateway injects
the right header") is testable without standing up a real auth system.
A production plugin would validate the key against Secrets Manager,
Cognito, Okta, whatever.

Deployed as a Lambda with a public Function URL (AuthType=NONE at the
URL layer — the auth gate lives in this handler).

Endpoints (served as MCP tools after plugin registration):

  GET /openapi.json                   — serves this API's own schema;
                                        used by the operator during
                                        plugin registration.
  GET /deliverables?asset_id=<id>     — operationId `get_asset_deliverables`
  GET /inventory_summary              — operationId `get_inventory_summary`
"""
import json
import os
from pathlib import Path

EXPECTED_API_KEY = "demo-del-k9x2"  # fake, hardcoded on purpose.

# Headers are lowercased by Lambda Function URL — same convention as
# API GW v2 proxy events — so we always compare lowercase.
AUTH_HEADER = "x-api-key"

# Seed inventory. Keyed by asset_id prefix; any asset_id starting
# with these magic prefixes gets its deliverable list. Everything else
# falls back to {"have": ["video"]} — same reality as the base
# distribution_card today.
SEED = {
    "aaaa": ["video", "poster", "subs:de", "trailer"],       # DE-ready
    "bbbb": ["video", "poster"],                             # DE missing subs+trailer
    "cccc": ["video", "poster", "subs:ja", "audio_desc:ja", "trailer"],  # JP-ready
    "dddd": ["video", "poster", "subs:pt-br", "trailer"],    # BR-ready
    "eeee": ["video"],                                       # bare
    "ffff": ["video", "poster", "subs:de", "subs:ja", "subs:pt-br", "trailer", "audio_desc:ja", "episode_art"],  # fully loaded
}


def _reply(status, body, headers=None):
    h = {"content-type": "application/json"}
    if headers: h.update(headers)
    return {"statusCode": status, "headers": h, "body": json.dumps(body)}


def _openapi_schema():
    """Load the sibling openapi.json file. Written as a static file
    so operators can also paste it directly into the Settings UI
    at registration time."""
    p = Path(__file__).parent / "openapi.json"
    return json.loads(p.read_text())


def _get_asset_deliverables(args):
    asset_id = (args.get("asset_id") or "").strip().lower()
    if not asset_id:
        return _reply(400, {"error": "asset_id query param is required"})
    for prefix, deliverables in SEED.items():
        if asset_id.startswith(prefix):
            return _reply(200, {
                "asset_id": asset_id,
                "have":     list(deliverables),
                "source":   "fakeapi-deliverables (demo)",
            })
    return _reply(200, {
        "asset_id": asset_id,
        "have":     ["video"],
        "source":   "fakeapi-deliverables (demo — unknown asset, defaulted to master video only)",
    })


def _get_inventory_summary(_args):
    """Aggregate counts across the seeded set, so the agent can
    reason about overall readiness ('N of M assets have German subs')."""
    totals = {
        "total_assets":        len(SEED),
        "with_poster":         0,
        "with_subs_de":        0,
        "with_subs_ja":        0,
        "with_subs_pt_br":     0,
        "with_trailer":        0,
        "with_audio_desc_ja":  0,
    }
    for deliverables in SEED.values():
        if "poster"        in deliverables: totals["with_poster"]        += 1
        if "subs:de"       in deliverables: totals["with_subs_de"]       += 1
        if "subs:ja"       in deliverables: totals["with_subs_ja"]       += 1
        if "subs:pt-br"    in deliverables: totals["with_subs_pt_br"]    += 1
        if "trailer"       in deliverables: totals["with_trailer"]       += 1
        if "audio_desc:ja" in deliverables: totals["with_audio_desc_ja"] += 1
    return _reply(200, {
        "summary": totals,
        "source":  "fakeapi-deliverables (demo)",
    })


def handler(event, _context):
    http   = (event.get("requestContext") or {}).get("http") or {}
    method = http.get("method", "GET").upper()
    path   = event.get("rawPath") or "/"
    qs     = event.get("queryStringParameters") or {}
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}

    # /openapi.json is unauth so operators can bootstrap registration.
    if method == "GET" and path.endswith("/openapi.json"):
        return _reply(200, _openapi_schema())

    # Auth gate — hardcoded compare proving Gateway injected the right
    # header. A production plugin would validate against a real store.
    key = (headers.get(AUTH_HEADER) or "").strip()
    if key != EXPECTED_API_KEY:
        return _reply(401, {
            "error":  "unauthorized",
            "detail": f"expected {AUTH_HEADER} header to match the configured demo key",
        })

    if method == "GET" and path.endswith("/deliverables"):
        return _get_asset_deliverables(qs)
    if method == "GET" and path.endswith("/inventory_summary"):
        return _get_inventory_summary(qs)
    return _reply(404, {"error": f"no route: {method} {path}"})
