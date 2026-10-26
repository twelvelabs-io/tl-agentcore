"""Reference AgentCore Gateway Lambda target. Exposes one tool,
`plugin_echo`, that returns whatever the caller passed in.

Purpose: smoke-test the whole plugin surface end-to-end. If the agent
can discover and call this tool, the gateway + loader + IAM wiring are
all correct. PR 2 adds the real reference MCP targets (audience /
rights / policy); this one stays around as the per-deploy health
check.

AgentCore Gateway lambda-target invocation shape (observed 2026-10-23):
  event              = raw tool arguments at top level, e.g. {"message": "hi"}
  context.client_context.custom["bedrockAgentCoreToolName"]
                     = "<target-name>___<tool-name>", e.g. "plugin-echo___plugin_echo"

The Lambda returns the tool result as JSON; the gateway re-wraps it
as an MCP tools/call response for the agent.
"""


def handler(event, context):
    full_name = ""
    cc = getattr(context, "client_context", None)
    if cc is not None:
        custom = getattr(cc, "custom", None) or {}
        full_name = custom.get("bedrockAgentCoreToolName") or ""
    tool = full_name.split("___", 1)[1] if "___" in full_name else full_name
    args = event if isinstance(event, dict) else {}

    if tool != "plugin_echo":
        return {"error": f"unknown tool: {tool!r} (full={full_name!r})"}

    message = args.get("message")
    if not isinstance(message, str):
        return {"error": "message must be a string"}

    return {"echoed": message, "length": len(message)}
