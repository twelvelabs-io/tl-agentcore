"""Static classifier for tool_call metering rows.

Problem (AGENT-4090 in Jockey): a single `tool_call` row shape makes
every tool call look the same in the ledger. A workload that leans on
`pegasus_analyze` + `qa_item` (direct-video Q&A, no retrieval) will
show "zero retrieval traffic" on a dashboard that counts tool_call rows
and look identical to an actual vector_search outage.

Fix: each tool_call row carries a `tool_category` field. Dashboards
can then say "retrieval traffic" (category=retrieval) vs "analysis
traffic" (category=analysis) and tell the two cases apart.

Categories:
  retrieval  — semantic / id lookup against the index or graph
  analysis   — model-backed per-asset analysis (Pegasus, MOSS, etc.)
  kb_read    — static KB catalog reads (no model, no retrieval scoring)
  mutation   — writes to DDB (memories, artifacts, feedback)
  generation — produces a new asset or executable artifact
  web        — hosted web search
  other      — catch-all; shows up as "other" in rollups

The map is a static dict rather than a decorator on each tool so that
a) `preseed.py` can categorize its synthetic kb_read calls without
touching every tool definition and b) a mis-registered or renamed tool
degrades to `other` instead of raising. Add a new entry when a new
tool lands."""
from __future__ import annotations

# Keep this map alphabetized within each category for scan-ability.
TOOL_CATEGORY: dict[str, str] = {
    # retrieval
    "find_by_image":                   "retrieval",
    "find_cached_entity_appearances":  "retrieval",
    "list_cached_entities":            "retrieval",
    "vector_search":                   "retrieval",

    # analysis
    "get_audio_context":   "analysis",
    "get_content_profile": "analysis",
    "get_shot_timeline":   "analysis",
    "get_transcript":      "analysis",
    "pegasus_analyze":     "analysis",
    "pegasus_segments":    "analysis",
    "qa_item":             "analysis",
    "zoom_in_video":       "analysis",

    # kb_read
    "get_kb_overview":        "kb_read",
    "jockey_list":            "kb_read",
    "jockey_list_runs":       "kb_read",
    "list_artifacts":         "kb_read",
    "list_audiences":         "kb_read",
    "list_filterable_fields": "kb_read",
    "list_kb_assets":         "kb_read",
    "list_kb_events":         "kb_read",
    "list_my_sessions":       "kb_read",
    "lookup_asset_profile":   "kb_read",
    "lookup_audience":        "kb_read",
    "lookup_event":           "kb_read",
    "lookup_rights":          "kb_read",
    "open_artifact":          "kb_read",

    # mutation
    "add_media":            "mutation",
    "feedback":             "mutation",
    "jockey_run":           "mutation",
    "jockey_save":          "mutation",
    "manage_artifacts":     "mutation",
    "manage_memory":        "mutation",
    "save_artifact":        "mutation",
    "save_tref_to_memory":  "mutation",

    # generation
    "execute_code":      "generation",
    "generate_html_app": "generation",
    "generate_video":    "generation",
    "render":            "generation",

    # web
    "web_search": "web",
}


def category_for(tool_name: str) -> str:
    """Return the category for `tool_name`, or `"other"` when unmapped.
    Never raises — a mis-registered or renamed tool should still write
    a usable row rather than drop metering."""
    return TOOL_CATEGORY.get(tool_name or "", "other")
