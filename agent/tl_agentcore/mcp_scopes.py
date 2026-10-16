"""OAuth-scope → tool mapping for the FastMCP projection (Jockey parity, PR #9).

Each tool declares exactly one required scope. An MCP client is projected a
subset of the full tool catalog based on the OAuth scopes present on its
request. Clients with no scopes see nothing; clients with every scope see
everything.

Scope names are the five verbatim Jockey scopes (locked decision in
`project_jockey_parity.md`):

    jockey.read            Any read-only lookup, retrieval, or model
                           grounding call. The vast majority of the catalog.
    jockey.ingest          Operations that bring new material into a KS or
                           the user's long-term memory.
    jockey.artifact-save   Writing persistent artifacts (saved plans,
                           generated html-1 apps, rendered videos).
    jockey.mining          Scheduled "mining plan" operations (roadmap #10).
    jockey.pipeline-select Reserved — intended for future pipeline-selection
                           tools (none in this PR).

Readers:
    scopes_for_tool(name)   -> str | None
    project_tools(scopes)   -> set[str]
"""
from __future__ import annotations

from typing import Iterable, Optional

# ─── Canonical scope names ──────────────────────────────────────────────────
SCOPE_READ            = "jockey.read"
SCOPE_INGEST          = "jockey.ingest"
SCOPE_ARTIFACT_SAVE   = "jockey.artifact-save"
SCOPE_MINING          = "jockey.mining"
SCOPE_PIPELINE_SELECT = "jockey.pipeline-select"

ALL_SCOPES: frozenset[str] = frozenset({
    SCOPE_READ,
    SCOPE_INGEST,
    SCOPE_ARTIFACT_SAVE,
    SCOPE_MINING,
    SCOPE_PIPELINE_SELECT,
})

# ─── Tool → scope mapping ───────────────────────────────────────────────────
# Only tools that exist on this branch are listed. Follow-on PRs add their
# tools here as they land (manage_memory + save_tref_to_memory in PR #16;
# get_transcript / get_shot_timeline / get_audio_context in PR #17;
# save_artifact / open_artifact / list_artifacts in PR #18).
TOOL_SCOPES: dict[str, str] = {
    # Tier 0 — AWS-native retrieval
    "vector_search":                   SCOPE_READ,
    "find_by_image":                   SCOPE_READ,
    # Tier 1 — Cache / profile / entity graph
    "get_kb_overview":                 SCOPE_READ,
    "list_kb_assets":                  SCOPE_READ,
    "lookup_asset_profile":            SCOPE_READ,
    "get_content_profile":             SCOPE_READ,
    "find_cached_entity_appearances":  SCOPE_READ,
    "list_cached_entities":            SCOPE_READ,
    "list_kb_events":                  SCOPE_READ,
    "lookup_event":                    SCOPE_READ,
    # On-demand asset registration (PR #8)
    "add_media":                       SCOPE_INGEST,
    # Mining plans (PR #10): save/list/run/list_runs. list + list_runs are
    # read-only but still gate behind jockey.mining — Jockey models mining
    # as a separate capability from general reads, and we honor that split.
    "jockey_save":                     SCOPE_MINING,
    "jockey_list":                     SCOPE_MINING,
    "jockey_run":                      SCOPE_MINING,
    "jockey_list_runs":                SCOPE_MINING,
    # Tier 2 — Bedrock Pegasus grounding
    "pegasus_analyze":                 SCOPE_READ,
    "pegasus_segments":                SCOPE_READ,
    "zoom_in_video":                   SCOPE_READ,
    # Ancillary DDB lookups
    "lookup_rights":                   SCOPE_READ,
    "list_audiences":                  SCOPE_READ,
    "lookup_audience":                 SCOPE_READ,
}


def scopes_for_tool(name: str) -> Optional[str]:
    """Return the scope string a tool requires, or None if the tool is
    unknown. Unknown tools are NOT exposed over MCP under any scope set."""
    return TOOL_SCOPES.get(name)


def project_tools(allowed_scopes: Iterable[str]) -> set[str]:
    """Return the set of tool names visible to a caller holding
    `allowed_scopes`. A tool is included iff its required scope is in the
    allowed set. Unknown scopes in the input are silently ignored."""
    allowed = set(allowed_scopes)
    return {name for name, scope in TOOL_SCOPES.items() if scope in allowed}
