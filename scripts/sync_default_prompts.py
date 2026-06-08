#!/usr/bin/env python3
"""Extract the two user-editable system prompts from their source files and
write them to lambda/settings/defaults.json — the source-of-truth defaults
the settings lambda hands back to the UI for "reset to default".

Sources:
  agent/tl_agentcore/agent.py        — SYSTEM_PROMPT (Python triple-quoted)
  lambda/asset_profile/index.mjs     — PROFILE_PROMPT (JS template literal)

Run this before `terraform apply` whenever either prompt is edited. Make
target wraps it.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT_PY = ROOT / "agent" / "tl_agentcore" / "agent.py"
ASSET_PROFILE_MJS = ROOT / "lambda" / "asset_profile" / "index.mjs"
OUT = ROOT / "lambda" / "settings" / "defaults.json"


def extract_python_triple_string(src: str, varname: str) -> str:
    m = re.search(
        rf'{re.escape(varname)}\s*=\s*"""(.+?)"""',
        src,
        flags=re.DOTALL,
    )
    if not m:
        raise SystemExit(f"could not find {varname} = \"\"\"…\"\"\" in source")
    return m.group(1)


def extract_js_template_literal(src: str, varname: str) -> str:
    m = re.search(
        rf'const\s+{re.escape(varname)}\s*=\s*`(.+?)`\s*;',
        src,
        flags=re.DOTALL,
    )
    if not m:
        raise SystemExit(f"could not find const {varname} = `…`; in source")
    return m.group(1)


def main() -> int:
    agent_src = AGENT_PY.read_text(encoding="utf-8")
    profile_src = ASSET_PROFILE_MJS.read_text(encoding="utf-8")

    agent_prompt = extract_python_triple_string(agent_src, "SYSTEM_PROMPT")
    pegasus_prompt = extract_js_template_literal(profile_src, "PROFILE_PROMPT")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "agent_system": {
                    "label": "Rough Cut Agent — system prompt",
                    "description": "Drives the entire Rough Cut planner: schema, parallel vector_search fan-out, cut-type table, adjacency invariants, conversation-mode classification.",
                    "source": "agent/tl_agentcore/agent.py · SYSTEM_PROMPT",
                    "text": agent_prompt,
                },
                "pegasus_profile": {
                    "label": "Pegasus profile prompt — per-asset ingest",
                    "description": "Sent to Bedrock Pegasus 1.2 for every newly uploaded clip. Output schema drives the ASSET# row written to kb_cache.",
                    "source": "lambda/asset_profile/index.mjs · PROFILE_PROMPT",
                    "text": pegasus_prompt,
                },
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {OUT.relative_to(ROOT)} "
        f"(agent_system={len(agent_prompt)} chars, pegasus_profile={len(pegasus_prompt)} chars)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
