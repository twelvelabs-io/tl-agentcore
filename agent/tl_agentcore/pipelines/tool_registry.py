"""Tool registry derived from the strands-decorated tools in agent.py.

Lazy-loaded to avoid circular import at module boot. The registry maps
tool_name → (callable, tool_spec_dict) so the ReWOO executor can look up
and invoke a tool by name using the exact same Python callable the
strands Agent would.

Two layers:

  * In-process tools (`@tool`-decorated callables inside agent.py) are
    stable per container and cached at module scope.
  * MCP-discovered gateway tools (anything registered via Settings →
    Data sources — see `agent.fetch_mcp_tools`) are per-invocation.
    `build_merged(mcp_tools)` merges them onto the in-process base so
    the ReWOO planner's catalog and the executor's registry both see
    whatever plugins are live right now. On a name collision the
    in-process tool wins so a customer can't accidentally shadow a
    built-in.

Public:
  get_tool_registry()                 -> dict[str, DecoratedFunctionTool]  (in-process only)
  get_tool_catalog()                  -> list[dict]                        (in-process only)
  build_merged(mcp_tools) -> (registry, catalog)                           (merged with MCP)
"""
from __future__ import annotations

import json
import threading
import uuid
from typing import Any

_registry_lock = threading.Lock()
_registry: dict[str, Any] | None = None
_catalog: list[dict[str, Any]] | None = None


def get_tool_registry() -> dict[str, Any]:
    """Return the shared {tool_name: DecoratedFunctionTool} map for the
    in-process toolset. MCP tools are not included — call
    `build_merged(mcp_tools)` to get the merged registry."""
    global _registry
    if _registry is not None:
        return _registry
    with _registry_lock:
        if _registry is not None:
            return _registry
        _registry = _build()
    return _registry


def get_tool_catalog() -> list[dict[str, Any]]:
    """Return the planner-friendly in-process tool catalog. MCP tools
    are not included — call `build_merged(mcp_tools)` to get the merged
    catalog."""
    global _catalog
    if _catalog is not None:
        return _catalog
    reg = get_tool_registry()
    _catalog = _catalog_from_registry(reg)
    return _catalog


def build_merged(mcp_tools: list[Any] | None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return `(registry, catalog)` with the given MCP tools merged on
    top of the cached in-process base.

    `mcp_tools` is the list returned by `agent.fetch_mcp_tools(...)` —
    strands `MCPAgentTool` instances that hold their own `mcp_client`
    reference. For each one we wrap the client's `call_tool_sync` as a
    plain sync callable the ReWOO executor can invoke the same way it
    invokes in-process `@tool`-decorated functions.

    Name collisions resolve in favor of the in-process entry; the MCP
    tool is dropped silently (a plugin can't shadow a built-in)."""
    base_reg = get_tool_registry()
    base_cat = get_tool_catalog()
    if not mcp_tools:
        return base_reg, base_cat

    merged_reg = dict(base_reg)
    merged_cat = list(base_cat)
    for mcp_tool in mcp_tools:
        name = getattr(mcp_tool, "tool_name", None) or getattr(mcp_tool, "__name__", None)
        if not name or name in merged_reg:
            continue
        merged_reg[name] = _mcp_sync_wrapper(mcp_tool)
        merged_cat.append(_catalog_entry_from_mcp(mcp_tool, name))
    return merged_reg, merged_cat


def _mcp_sync_wrapper(mcp_tool: Any):
    """Wrap an MCPAgentTool so the ReWOO executor can `tool(**args)` it.

    Returns a plain callable: args go in as kwargs, the MCP tool is
    invoked synchronously against its own `mcp_client`, and the first
    text content block is JSON-parsed into a dict (falling back to the
    raw text string when the payload isn't JSON). An MCP server that
    reports `isError` becomes a plain `{"error": "..."}` dict so the
    executor's existing error-recording path handles it."""
    client = getattr(mcp_tool, "mcp_client", None)
    inner_name = getattr(getattr(mcp_tool, "mcp_tool", None), "name", None)
    if client is None or not inner_name:
        def _broken(**_kwargs):
            return {"error": "mcp tool is missing its client or name — plugin init bug"}
        return _broken

    def _call(**arguments):
        tool_use_id = f"call_{uuid.uuid4().hex[:12]}"
        try:
            result = client.call_tool_sync(
                tool_use_id=tool_use_id,
                name=inner_name,
                arguments=arguments or {},
            )
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}
        return _unpack_mcp_result(result)

    return _call


def _unpack_mcp_result(result: Any) -> Any:
    """Turn an MCPToolResult into something the solver prompt can read.

    Prefer the first text block, JSON-parse when possible so the solver
    gets dict access via <step_N.field> placeholders. Preserve
    application-level errors as `{"error": "..."}` so the executor's
    existing gap-tolerant path handles them."""
    if not isinstance(result, dict):
        return result
    content = result.get("content") or []
    for block in content:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            raw = block["text"]
            try:
                parsed = json.loads(raw)
            except (ValueError, TypeError):
                return raw
            if result.get("isError") or result.get("status") == "error":
                return {"error": parsed if isinstance(parsed, str) else json.dumps(parsed)[:400]}
            return parsed
    if result.get("isError") or result.get("status") == "error":
        return {"error": "mcp tool reported isError with no text content"}
    return result


def _catalog_entry_from_mcp(mcp_tool: Any, name: str) -> dict[str, Any]:
    try:
        spec = mcp_tool.tool_spec or {}
    except Exception:
        spec = {}
    description = (spec.get("description") or "").strip()
    if len(description) > 400:
        description = description[:397] + "..."
    schema = (spec.get("inputSchema") or {}).get("json") or {}
    properties = schema.get("properties") or {}
    required = schema.get("required") or []
    args: list[dict[str, Any]] = []
    for pname, pschema in properties.items():
        args.append({
            "name": pname,
            "type": (pschema or {}).get("type", "any"),
            "required": pname in required,
            "description": ((pschema or {}).get("description") or "")[:200],
        })
    return {"name": name, "description": description, "args": args}


def _catalog_from_registry(reg: dict[str, Any]) -> list[dict[str, Any]]:
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
    return cat


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
        _a.qa_item,
        _a.get_transcript, _a.get_shot_timeline, _a.get_audio_context,
        _a.manage_memory, _a.save_tref_to_memory,
        _a.list_my_sessions,
        _a.generate_html_app, _a.generate_video, _a.execute_code,
        _a.web_search,
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
