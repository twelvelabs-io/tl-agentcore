# FastMCP server + OAuth-scope projection

tl-agentcore ships a FastMCP server that exposes the agent's tool catalog
to external MCP clients (Claude Desktop, external agents, scripts). Which
tools a client sees is filtered by **OAuth scopes** — the five verbatim
Jockey scopes.

## Scopes

| Scope                     | Tools (as of this branch)                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jockey.read`             | `vector_search`, `find_by_image`, `get_kb_overview`, `list_kb_assets`, `lookup_asset_profile`, `get_content_profile`, `find_cached_entity_appearances`, `list_cached_entities`, `list_kb_events`, `lookup_event`, `pegasus_analyze`, `pegasus_segments`, `zoom_in_video`, `generate_html_app`, `generate_video`, `execute_code`, `lookup_rights`, `list_audiences`, `lookup_audience` |
| `jockey.ingest`           | `add_media`                                                                                                                                                         |
| `jockey.artifact-save`    | *(reserved — PR #18 wires `save_artifact` / `open_artifact` / `list_artifacts`)*                                                                                     |
| `jockey.mining`           | `jockey_save`, `jockey_list`, `jockey_run`, `jockey_list_runs`                                                                                                        |
| `jockey.pipeline-select`  | *(reserved — no tools yet)*                                                                                                                                          |

The mapping is the single-source-of-truth in
`agent/tl_agentcore/mcp_scopes.py`; follow-on roadmap PRs add their tools
to that dict as they land.

## Running the server (local dev)

```bash
cd agent
uv venv && . .venv/bin/activate && uv pip install -r requirements.txt
# All scopes (local dev / Claude Desktop testing default):
python -m tl_agentcore.mcp_server
# Narrow surface:
MCP_SCOPES=jockey.read python -m tl_agentcore.mcp_server
MCP_SCOPES=jockey.read,jockey.ingest python -m tl_agentcore.mcp_server
```

The server speaks stdio by default (what Claude Desktop expects). First
line to stderr lists the projected tool catalog so you can confirm the
scope filter is doing what you asked.

## Pointing Claude Desktop at it

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tl-agentcore": {
      "command": "python",
      "args": ["-m", "tl_agentcore.mcp_server"],
      "env": {
        "MCP_SCOPES":          "jockey.read",
        "AWS_REGION":          "us-east-1",
        "AWS_PROFILE":         "TLSolProd",
        "CLIPS_BUCKET_NAME":   "tl-agentcore-1c323e-clips",
        "CLIPS_BUCKET_OWNER":  "026090552520",
        "KB_CACHE_TABLE":      "tl-agentcore-1c323e-kb-cache",
        "VECTOR_BUCKET_NAME":  "tl-agentcore-1c323e-vectors",
        "VECTOR_INDEX_VISUAL": "asset-embeddings-visual",
        "VECTOR_INDEX_AUDIO":  "asset-embeddings-audio",
        "VECTOR_INDEX_TRANSCRIPTION": "asset-embeddings-transcription"
      }
    }
  }
}
```

(Point `command` at the venv's `python` if it's not on PATH globally.
Each env var is read lazily by the agent module on tool invocation, so a
missing one only fails the tool that needs it, not startup.)

## Production hosting — intentionally deferred

OAuth-scope validation (decoding a Cognito JWT, reading the `scope`
claim, matching against `TOOL_SCOPES`) is **out of this PR**. The two
intended production shapes:

1. **One MCP server process per scope bucket, behind an auth proxy.**
   ALB/API Gateway reads the token's scopes, routes the request to the
   matching `MCP_SCOPES=<...>` instance. Dumbest and most forgiving: the
   projection decision happens at process-start time, not per-request.

2. **Middleware shim.** When the MCP Python SDK settles on an
   auth-context API, add a middleware that mutates the exposed tool list
   per-request. Keeps the process count at one.

Either way the plumbing in `mcp_scopes.py` + `build_mcp_server()` is the
mechanism; the hosting + validation shim is one focused follow-up PR.
