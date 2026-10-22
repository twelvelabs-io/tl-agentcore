"""Per-tool / per-model metering (wave-2 PR #10 of Jockey parity).

Public surface:
  record_model_invocation(user_id, model_id, input_tokens, output_tokens,
                          latency_ms, response_id, knowledge_store_id)
  record_tool_call(user_id, tool_name, duration_ms, response_id,
                   knowledge_store_id)

Both are fire-and-forget wrappers over DDB PutItem. Any failure logs and
returns — a metering miss is strictly better than a broken user response.

Prices live in SSM Parameter Store at `/tl-agentcore/prices/<model_id>`
as a JSON blob {"input_per_mtok": float, "output_per_mtok": float}. The
cache is per-process with a configurable TTL (default 15 min) so ops can
bump a price without a redeploy. See prices.py.
"""
from .ledger import record_model_invocation, record_tool_call
from .prices import price_for_model

__all__ = [
    "record_model_invocation",
    "record_tool_call",
    "price_for_model",
]
