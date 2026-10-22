"""Bucket agent + tool errors into a small enum of stable codes so the UI
can render failure modes consistently rather than regex-matching stack
traces. Parity with Jockey's responses/failure_classification.py; our
version carries the AWS-flavored strings (ThrottlingException, NoSuchKey,
AccessDeniedException, ValidationException) that show up in Bedrock /
DynamoDB / S3 responses.

Public contract: `classify(message, exc=None) -> str`. The returned
string is one of the module-level constants below. New codes get added
at the bottom and never renamed — the UI maps on these.
"""
from __future__ import annotations

import re
from typing import Final

# Stable string codes. Keep the names here; downstream code (SSE events,
# UI) references them as strings, not as imports. New codes append at the
# bottom of this block.
UNKNOWN: Final = "unknown"
NOT_FOUND: Final = "not_found"
PERMISSION: Final = "permission"
RATE_LIMIT: Final = "rate_limit"
THROTTLED: Final = "throttled"
VALIDATION: Final = "validation"
TIMEOUT: Final = "timeout"
MODEL_ERROR: Final = "model_error"
NETWORK: Final = "network"
CONFIG: Final = "config"

# Order matters: first match wins. Patterns are case-insensitive. Each
# pattern targets both the AWS exception-class names (ThrottlingException,
# NoSuchKey, …) and the human prose that leaks into our hand-rolled
# `return {"error": "..."}` tool branches.
_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (RATE_LIMIT, re.compile(r"rate.?limit|quota.?exceeded|429|too[_ ]?many[_ ]?requests", re.I)),
    (THROTTLED, re.compile(r"throttl|ThrottlingException|SlowDown", re.I)),
    (TIMEOUT, re.compile(r"timed?[ _-]?out|timeout|ReadTimeout|504\b", re.I)),
    (NOT_FOUND, re.compile(r"not[ _-]?found|NoSuchKey|NoSuchBucket|does not exist|ResourceNotFound|ResourceNotFoundException|404\b", re.I)),
    (PERMISSION, re.compile(r"access[ _-]?denied|AccessDeniedException|UnauthorizedOperation|not[ _-]?authorized|forbidden|InvalidToken|credentials[ _-]?not[ _-]?found|signature.{0,20}does not match|403\b", re.I)),
    (CONFIG, re.compile(r"env var.{0,20}required|not configured|BUCKET_NAME|INDEX_NAME required|TL_API_KEY", re.I)),
    (VALIDATION, re.compile(r"ValidationException|invalid (?:param|argument|key|JSON|body|input)|missing (?:prompt|param|arg|required)|\bis required\b|does not conform|schema", re.I)),
    (NETWORK, re.compile(r"ConnectionError|ConnectionResetError|DNS|unreachable|network is down|getaddrinfo", re.I)),
    (MODEL_ERROR, re.compile(r"ModelError|ModelErrorException|ModelTimeoutException|InvokeModel.{0,20}failed|Bedrock.{0,20}error|model (?:failed|returned no)", re.I)),
)


def classify(message: str | None, exc: BaseException | None = None) -> str:
    """Return a stable bucket code for an error, picking the first
    matching pattern. Pass whichever of `message` / `exc` you have; the
    function concatenates whatever text it finds and runs the pattern
    set over it. Empty input → UNKNOWN."""
    pieces: list[str] = []
    if message:
        pieces.append(str(message))
    if exc is not None:
        pieces.append(type(exc).__name__)
        pieces.append(str(exc))
    text = " ".join(pieces).strip()
    if not text:
        return UNKNOWN
    for code, pat in _PATTERNS:
        if pat.search(text):
            return code
    return UNKNOWN
