"""Tool registry derived from the strands-decorated tools in agent.py.

Lazy-loaded to avoid circular import at module boot. The registry maps
tool_name → (callable, tool_spec_dict) so the ReWOO executor can look up
and invoke a tool by name using the exact same Python callable the
strands Agent would.

Public:
  get_tool_registry() -> dict[str, DecoratedFunctionTool]
  get_tool_catalog() -> list[dict]   # name/description/schema trio per tool
"""
from __future__ import annotations

import threading
from typing import Any

_registry_lock = threading.Lock()
_registry: dict[str, Any] | None = None
_catalog: list[dict[str, Any]] | None = None


def get_tool_registry() -> dict[str, Any]:
    """Return the shared {tool_name: DecoratedFunctionTool} map."""
    global _registry
    if _registry is not None:
        return _registry
    with _registry_lock:
        if _registry is not None:
            return _registry
        _registry = _build()
    return _registry


def get_tool_catalog() -> list[dict[str, Any]]:
    """Return a lightweight list of {name, description, input_schema}
    dicts suitable for prompting a planner model."""
    global _catalog
    if _catalog is not None:
        return _catalog
    reg = get_tool_registry()
    cat: list[dict[str, Any]] = []
    for name, tool in reg.items():
        try:
            spec = tool.tool_spec or {}
        except Exception:
            spec = {}
        description = (spec.get("description") or "").strip()
        if len(description) > 400:
            description = description[:397] + "..."
        schema = (spec.get("inputSchema") or {}).get("json") or {}
        properties = schema.get("properties") or {}
        required = schema.get("required") or []
        # Compact per-arg lines keep the planner prompt small.
        args: list[dict[str, Any]] = []
        for pname, pschema in properties.items():
            args.append({
                "name": pname,
                "type": (pschema or {}).get("type", "any"),
                "required": pname in required,
                "description": ((pschema or {}).get("description") or "")[:200],
            })
        cat.append({
            "name": name,
            "description": description,
            "args": args,
        })
    _catalog = cat
    return _catalog


def _build() -> dict[str, Any]:
    """Import agent.build_agent indirectly and collect its tool list.

    We don't need the Agent instance itself — only the list of @tool
    callables it would register. That list is defined inline inside
    build_agent(), so we import the module and read the @tool-decorated
    callables by name. Keeping this list in one place (agent.py) is the
    single source of truth; mirroring it here would drift."""
    from .. import agent as _a

    tools = [
        _a.vector_search, _a.find_by_image,
        _a.get_kb_overview, _a.list_kb_assets, _a.lookup_asset_profile,
        _a.get_content_profile, _a.find_cached_entity_appearances,
        _a.list_cached_entities, _a.list_kb_events, _a.lookup_event,
        _a.add_media,
        _a.jockey_save, _a.jockey_list, _a.jockey_run, _a.jockey_list_runs,
        _a.pegasus_analyze, _a.pegasus_segments, _a.zoom_in_video,
        _a.get_transcript, _a.get_shot_timeline, _a.get_audio_context,
        _a.manage_memory, _a.save_tref_to_memory,
        _a.list_my_sessions,
        _a.generate_html_app, _a.generate_video, _a.execute_code,
        _a.save_artifact, _a.open_artifact, _a.list_artifacts,
        _a.render, _a.manage_artifacts, _a.list_filterable_fields,
        _a.feedback,
        _a.lookup_rights, _a.list_audiences, _a.lookup_audience,
    ]
    out: dict[str, Any] = {}
    for t in tools:
        name = getattr(t, "tool_name", None) or getattr(t, "__name__", None)
        if not name:
            continue
        out[name] = t
    return out
