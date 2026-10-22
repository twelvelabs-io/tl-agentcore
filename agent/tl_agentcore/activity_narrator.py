"""Human-readable "doing X now" narration for in-flight tool calls.

Parity with Jockey's responses/activity_{narration,narrator,projection}.py
family. The UI's existing `function_call` output items show tool_name +
raw JSON arguments; good for debugging, lousy for a live status line.
This module turns those raw args into a single present-tense sentence
the UI can render as a "status pip" alongside the stream.

Contract: `narrate(tool_name, arguments) -> str`. Pure function. If a
tool isn't in the TEMPLATES table it falls back to "Running {tool_name}".
Keep the sentences short (one line, no trailing punctuation beyond "…"
or "."), present-tense, and user-friendly — this is UX surface, not a
log line.
"""
from __future__ import annotations

import re
from typing import Any

# One short narration per tool. {placeholder} fields are read from the
# tool_use arguments dict with .get() — a missing key renders as empty
# string via _safe_format, so a partial template never explodes.
#
# Grouped by purpose to make it easy to spot a missing entry when a new
# tool lands.
TEMPLATES: dict[str, str] = {
    # ─── Retrieval / routing ───────────────────────────────────────
    "vector_search":                   "Searching for “{query_text}” across visual + audio + transcription",
    "find_by_image":                   "Finding clips that look like the reference image",
    # ─── KB cache lookups ──────────────────────────────────────────
    "get_kb_overview":                 "Loading the knowledge-base overview",
    "list_kb_assets":                  "Listing assets in this knowledge base",
    "list_kb_events":                  "Listing multi-clip events in this knowledge base",
    "lookup_event":                    "Looking up event {event_id}",
    "find_cached_entity_appearances":  "Finding every clip that features {entity_name}",
    "list_cached_entities":            "Listing recognized entities in this knowledge base",
    "lookup_asset_profile":            "Reading the cached profile for {asset_id}",
    "get_content_profile":             "Reading the cached profile for {asset_id}",
    # ─── Per-clip analysis ─────────────────────────────────────────
    "pegasus_analyze":                 "Analyzing clip {asset_id} with Pegasus",
    "pegasus_segments":                "Running time-based Pegasus segments on {asset_id}",
    "zoom_in_video":                   "Zooming into {asset_id} ({start_time}–{end_time}s)",
    "get_transcript":                  "Pulling the transcript for {asset_id}",
    "get_shot_timeline":               "Pulling the shot timeline for {asset_id}",
    "get_audio_context":               "Pulling the audio context for {asset_id}",
    # ─── Domain lookups ────────────────────────────────────────────
    "lookup_rights":                   "Checking rights for {asset_id}",
    "lookup_audience":                 "Looking up audience segment {segment_id}",
    "list_audiences":                  "Listing audience segments",
    # ─── Memory / selections / media ───────────────────────────────
    "manage_memory":                   "Updating your long-term memory",
    "save_tref_to_memory":             "Saving a clip reference to memory",
    "add_media":                       "Registering new media in this knowledge base",
    # ─── Artifacts ─────────────────────────────────────────────────
    "save_artifact":                   "Saving an artifact ({kind})",
    "open_artifact":                   "Opening artifact {artifact_id}",
    "list_artifacts":                  "Listing your saved artifacts",
    # ─── Mining / jockey plans ─────────────────────────────────────
    "jockey_save":                     "Saving the mining plan “{prompt}”",
    "jockey_list":                     "Listing saved mining plans",
    "jockey_run":                      "Running mining plan {plan_id} now",
    "jockey_list_runs":                "Listing runs for mining plan {plan_id}",
    # ─── Generation ────────────────────────────────────────────────
    "generate_html_app":                "Generating a self-contained HTML app",
    "generate_video":                   "Rendering a stitched preview video",
    "execute_code":                     "Running a short Python snippet",
}


def narrate(tool_name: str, arguments: Any) -> str:
    """Return one present-tense sentence describing the tool call in
    flight. Falls back to a generic phrase for unknown tools."""
    args = arguments if isinstance(arguments, dict) else {}
    template = TEMPLATES.get(tool_name)
    if not template:
        return f"Running {tool_name}"
    return _safe_format(template, args)


def _safe_format(template: str, args: dict) -> str:
    """Format `template` against `args`, replacing missing keys with the
    empty string. Then collapse any resulting "  " / " ." / stray
    delimiters so a partial-args fill still reads naturally."""
    class _Blank(dict):
        def __missing__(self, key: str) -> str:
            return ""
    rendered = template.format_map(_Blank(args))
    # Collapse the artefacts of empty slots: unfilled quotes (""),
    # parenthesized time ranges that lost both bounds (`(–s)` /
    # `( – s)` / `( s)`), and runs of extra space.
    rendered = _EMPTY_QUOTES.sub('', rendered)
    rendered = _EMPTY_BRACKET.sub(' ', rendered)
    rendered = _MULTI_SPACE.sub(' ', rendered)
    return rendered.strip(' ,.-')


_EMPTY_QUOTES = re.compile(r'[“"][”"]')
_EMPTY_BRACKET = re.compile(r'\s*\((?:\s|[–\-s])*\)')
_MULTI_SPACE = re.compile(r'\s{2,}')
