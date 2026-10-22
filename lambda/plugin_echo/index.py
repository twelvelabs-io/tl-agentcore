"""Reference AgentCore Gateway Lambda target. Exposes one tool,
`plugin_echo`, that returns whatever the caller passed in.

Purpose: smoke-test the whole plugin surface end-to-end. If the agent
can discover and call this tool, the gateway + loader + IAM wiring are
all correct. PR 2 adds the real reference MCP targets (audience /
rights / policy); this one stays around as the per-deploy health
check.

Invocation shape — Bedrock AgentCore Gateway unwraps the MCP
tools/call envelope and sends the Lambda a plain event:

    {
      "tool":      "plugin_echo",
      "arguments": {"message": "hi"}
    }

The Lambda returns the tool result as JSON; the gateway re-wraps it
as an MCP tools/call response for the agent.
"""


def handler(event, _context):
    tool = event.get("tool")
    args = event.get("arguments") or {}

    if tool != "plugin_echo":
        return {"error": f"unknown tool: {tool!r}"}

    message = args.get("message")
    if not isinstance(message, str):
        return {"error": "message must be a string"}

    return {"echoed": message, "length": len(message)}
