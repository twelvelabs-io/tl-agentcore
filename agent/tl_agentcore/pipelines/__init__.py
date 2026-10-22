"""Pipeline-selection + ReWOO executor (wave-2 PR #11 of Jockey parity).

Two execution pipelines for a user turn:
  - ReAct (the default, in-process strands Agent loop)
  - ReWOO = Reasoning WithOut Observation (planner + executor + solver;
    the model plans every tool call up front, the executor runs them,
    the model composes a final answer from the observations).

`select_pipeline(payload)` picks which one runs for a given turn:
  - payload.pipeline explicitly set? honor it ("rewoo" | "react").
  - else: classify the prompt (INFORMATIONAL | STRUCTURAL | AMBIGUOUS)
    with a cheap Haiku call and route INFORMATIONAL → ReWOO,
    STRUCTURAL/AMBIGUOUS → ReAct. See router.py.

`run_rewoo(...)` yields the same `__kind__`-tagged semantic events the
runtime's existing semantic_stream emits, so the SSE/WS envelope wrapper
works unchanged. On any executor error, run_rewoo raises
`RewooFallback` — the caller (runtime._semantic_stream) catches it and
re-runs the turn through ReAct.
"""
from .router import classify_mode, select_pipeline
from .rewoo import RewooFallback, run_rewoo

__all__ = [
    "classify_mode",
    "select_pipeline",
    "run_rewoo",
    "RewooFallback",
]
