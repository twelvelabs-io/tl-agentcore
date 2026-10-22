"""Classifier that turns a RewooFallback exception message into a short
reason slug + stage tag for aggregation.

Why not just log the raw exception text: the message text is useful for
one-off debugging but useless for "what are the top 5 fallback reasons
this week?" — every variable interpolation (`unknown tool: 'foo'`,
`unknown tool: 'bar'`) breaks the group-by. A short slug collapses the
cardinality so dashboards can actually count things.

Reason classes correspond to the raise sites in pipelines/rewoo.py.
When a new raise site is added there, extend `_PATTERNS` here with a
regex that matches its message prefix.
"""
from __future__ import annotations

import re
from typing import NamedTuple


class FallbackReason(NamedTuple):
    reason_class: str
    stage: str


# ("regex over the message", (reason_class, stage))
#
# Order matters — the first match wins, so put more-specific patterns
# before more-general ones. The patterns match the start of the
# RewooFallback message as raised in pipelines/rewoo.py.
_PATTERNS: list[tuple[re.Pattern, FallbackReason]] = [
    (re.compile(r"^planner invoke_model failed"),  FallbackReason("planner_invoke_failed", "planner")),
    (re.compile(r"^planner returned non-JSON"),    FallbackReason("planner_non_json",      "planner")),
    (re.compile(r"^planner returned non-list"),    FallbackReason("planner_shape",         "planner")),
    (re.compile(r"^planner produced \d+ steps"),   FallbackReason("planner_shape",         "planner")),
    (re.compile(r"^malformed step"),               FallbackReason("plan_step_malformed",   "plan_parse")),
    (re.compile(r"^unknown tool"),                 FallbackReason("plan_unknown_tool",     "plan_parse")),
    (re.compile(r"^args must be a dict"),          FallbackReason("plan_args_shape",       "plan_parse")),
    (re.compile(r"^variable miss in step"),        FallbackReason("plan_variable_miss",    "executor")),
    (re.compile(r"^tool \S+ bad args"),            FallbackReason("tool_bad_args",         "executor")),
    (re.compile(r"^solver invoke_model failed"),   FallbackReason("solver_invoke_failed",  "solver")),
]

_FALLBACK = FallbackReason("other", "unknown")


def classify_fallback(message: str) -> FallbackReason:
    """Return (reason_class, stage) for a RewooFallback message. Falls
    back to ("other", "unknown") when no pattern matches — a new raise
    site landed in rewoo.py without a matching entry here. Not an
    error, just the signal to extend `_PATTERNS`."""
    msg = (message or "").strip()
    for pat, reason in _PATTERNS:
        if pat.match(msg):
            return reason
    return _FALLBACK
