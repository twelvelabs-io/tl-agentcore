"""AgentCore Runtime entrypoint.

Exposes:
  POST /invocations    — invoke the agent with a JSON payload
  GET  /ping           — health check

Payload:
  {
    "knowledge_store_id": "ks_...",
    "prompt": "...",
    "access_token": "<cognito jwt>"   # optional — when present, the agent
                                      # authenticates to the MCP Gateway with
                                      # this token. Absent → in-process tools.
  }
"""

from __future__ import annotations

import os
import traceback

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from .agent import build_agent

app = BedrockAgentCoreApp()


@app.entrypoint
def invoke(payload: dict, _context=None):
    """One agent turn. Rebuilt per-request because the access token rotates."""
    ks = payload.get("knowledge_store_id")
    prompt = payload.get("prompt") or ""
    access_token = payload.get("access_token")
    if not prompt:
        return {"error": "missing prompt"}

    user_text = prompt if not ks else f"[ks: {ks}]\n{prompt}"

    try:
        agent, mode = build_agent(access_token=access_token)
    except Exception as e:
        return {"error": f"agent build failed: {e}", "trace": traceback.format_exc()}

    try:
        result = agent(user_text)
        return {"text": str(result), "tool_path": mode}
    except Exception as e:
        return {
            "error": f"agent run failed: {e}",
            "trace": traceback.format_exc(),
            "tool_path": mode,
        }


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
