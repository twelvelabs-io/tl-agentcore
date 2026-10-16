"""FastMCP server exposing the tl-agentcore tool catalog with OAuth-scope
projection (Jockey parity, PR #9).

Launches as `python -m tl_agentcore.mcp_server`; by default serves over stdio,
which is the shape Claude Desktop and other MCP clients consume.

Scope projection
----------------
At server-build time we pick the subset of tools whose required scope sits
inside the caller's allowed-scope set:

    build_mcp_server(allowed_scopes={"jockey.read"})

exposes only read-only tools. The mapping lives in `mcp_scopes.py` and is
the single source of truth.

The command-line entrypoint reads the `MCP_SCOPES` env var (comma-separated,
e.g. `MCP_SCOPES=jockey.read,jockey.ingest`) and projects accordingly;
unset → all five scopes (local dev / Claude Desktop testing without an auth
front).

OAuth validation itself (decoding a Cognito JWT and reading its `scope`
claim) is intentionally OUT of this PR. The intended production shape is
one of:

  a) Deploy multiple MCP server processes, one per scope bucket, behind an
     auth proxy (ALB/API Gateway) that routes requests to the right one
     based on the token's scopes.
  b) Add a middleware shim that mutates the exposed tool list per-request
     once the MCP Python SDK settles on an auth-context API.

Either way, this file ships the mechanism (projection) that the production
auth story will plug into.
"""
from __future__ import annotations

import os
import sys
from typing import Iterable, Optional

# Import the tool module eagerly — @tool-decorated callables need to be
# available by name so we can register exactly the subset the scope projection
# allows. We keep the import under a guard so `python -m tl_agentcore.mcp_scopes`
# unit tests work without requiring the full strands + boto stack to import.
from . import agent as _agent_module
from .mcp_scopes import ALL_SCOPES, TOOL_SCOPES, project_tools


def _unwrap_tool(obj):
    """Return the underlying plain-Python callable behind a strands @tool
    wrapper. Strands wraps tool funcs; FastMCP's own @tool decorator needs
    to see the plain function so it can introspect its signature + docstring.
    """
    for attr in ("original_function", "func", "_fn"):
        inner = getattr(obj, attr, None)
        if callable(inner):
            return inner
    return obj


def build_mcp_server(
    allowed_scopes: Optional[Iterable[str]] = None,
    *,
    name: str = "tl-agentcore",
):
    """Return a FastMCP server exposing only tools whose required scope sits
    inside `allowed_scopes`. `None` means expose everything (local-dev / Claude
    Desktop default).

    Lazy-imports FastMCP so the scope module stays testable without the mcp
    package installed.
    """
    try:
        from mcp.server.fastmcp import FastMCP  # type: ignore
    except ImportError as e:
        raise ImportError(
            "FastMCP not installed. Add `mcp>=1.0` to the venv:\n"
            "    pip install 'mcp>=1.0'\n"
            f"(underlying import error: {e})"
        ) from e

    scopes = set(allowed_scopes) if allowed_scopes is not None else set(ALL_SCOPES)
    exposed = project_tools(scopes)

    server = FastMCP(name)
    for tool_name in sorted(exposed):
        fn = getattr(_agent_module, tool_name, None)
        if fn is None:
            # Scope mapping lists a tool that doesn't exist on this branch
            # — expected while the roadmap stack is in flight. Skip quietly.
            continue
        server.tool(name=tool_name)(_unwrap_tool(fn))
    return server, exposed


def _scopes_from_env() -> Optional[set[str]]:
    raw = os.environ.get("MCP_SCOPES", "").strip()
    if not raw:
        return None
    requested = {s.strip() for s in raw.split(",") if s.strip()}
    unknown = requested - set(ALL_SCOPES)
    if unknown:
        print(
            f"mcp_server: ignoring unknown scopes {sorted(unknown)}; "
            f"known scopes are {sorted(ALL_SCOPES)}",
            file=sys.stderr,
        )
    return requested & set(ALL_SCOPES)


def main() -> None:
    scopes = _scopes_from_env()
    server, exposed = build_mcp_server(scopes)
    scope_label = ",".join(sorted(scopes)) if scopes is not None else "ALL"
    print(
        f"mcp_server: exposing {len(exposed)} tool(s) under scopes [{scope_label}]: "
        f"{sorted(exposed)}",
        file=sys.stderr,
    )
    # FastMCP defaults to stdio; `transport` arg accepts "stdio" / "sse" /
    # "streamable-http". We leave it at the default so Claude Desktop can
    # consume it directly.
    server.run()


if __name__ == "__main__":
    main()
