"""SSM Parameter Store-backed price lookup for Bedrock models + hosted
services. Shape of each parameter value (JSON blob):

    {"input_per_mtok": 3.0, "output_per_mtok": 15.0, "currency": "USD"}

Lookup path: `{PRICES_SSM_PREFIX}/<model_id>` where PRICES_SSM_PREFIX
defaults to `/tl-agentcore/prices`. Example parameter name:
`/tl-agentcore/prices/us.anthropic.claude-sonnet-4-6`.

Per-process cache with TTL (default 15 min — PRICES_CACHE_TTL_SECONDS) so
ops can push a new rate without a redeploy. A missing parameter is
cached as `None` so a 404 doesn't hammer SSM on every subsequent model
turn.

Public: `price_for_model(model_id) -> dict | None`.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

import boto3  # type: ignore

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_PREFIX = os.environ.get("PRICES_SSM_PREFIX", "/tl-agentcore/prices").rstrip("/")
_TTL_S = int(os.environ.get("PRICES_CACHE_TTL_SECONDS", "900"))

_ssm = boto3.client("ssm", region_name=_REGION)

# Cache map: model_id -> (expires_epoch_s, price_dict | None)
_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_lock = threading.Lock()


def price_for_model(model_id: str) -> dict[str, Any] | None:
    """Return the price dict for `model_id`, or None if unpriced.

    Shape: {"input_per_mtok": float, "output_per_mtok": float,
             "currency": "USD", "source": "ssm:/tl-agentcore/prices/<model_id>"}

    Returning None is a valid outcome — the ledger falls back to writing
    the row with cost=null, so tokens stay useful even before ops
    populate the parameter.
    """
    if not model_id:
        return None
    now = time.monotonic()
    with _lock:
        hit = _cache.get(model_id)
        if hit and hit[0] > now:
            return hit[1]

    price = _fetch(model_id)
    with _lock:
        _cache[model_id] = (now + _TTL_S, price)
    return price


def _fetch(model_id: str) -> dict[str, Any] | None:
    name = f"{_PREFIX}/{model_id}"
    try:
        r = _ssm.get_parameter(Name=name, WithDecryption=False)
    except _ssm.exceptions.ParameterNotFound:
        return None
    except Exception as e:
        print(f"metering/prices: SSM lookup failed for {name}: {e}")
        return None
    try:
        payload = json.loads(r["Parameter"]["Value"])
    except (KeyError, ValueError, TypeError) as e:
        print(f"metering/prices: bad JSON at {name}: {e}")
        return None
    if not isinstance(payload, dict):
        return None
    payload.setdefault("currency", "USD")
    payload["source"] = f"ssm:{name}"
    return payload


def compute_cost_usd(
    input_tokens: int,
    output_tokens: int,
    price: dict[str, Any] | None,
) -> float | None:
    """Multiply tokens * per-MTok rate. Returns None when the price
    isn't known yet (keeps the ledger row writable without lying)."""
    if not price:
        return None
    try:
        in_rate = float(price.get("input_per_mtok", 0.0))
        out_rate = float(price.get("output_per_mtok", 0.0))
    except (TypeError, ValueError):
        return None
    cost = (max(0, int(input_tokens)) * in_rate +
            max(0, int(output_tokens)) * out_rate) / 1_000_000.0
    return round(cost, 8)


def _clear_cache_for_tests() -> None:
    with _lock:
        _cache.clear()
