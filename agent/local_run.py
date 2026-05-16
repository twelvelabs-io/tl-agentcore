"""Local smoke driver — invokes the Strands agent without the runtime wrapper.

Usage:
    cd agent
    python -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt
    export TL_API_KEY=$(grep TL_API_KEY ../.env | cut -d= -f2)
    export AWS_PROFILE=...           # for Bedrock model access
    export PROFILE_CACHE_TABLE=...        # optional — enables Tier 1 cache

    python local_run.py ks_069f7c02-... "build me a 30s action highlight reel"
"""

from __future__ import annotations

import os
import sys

from tl_agentcore.agent import build_agent


def main():
    if len(sys.argv) < 3:
        print("usage: python local_run.py <knowledge_store_id> <prompt>")
        sys.exit(2)
    ks_id, prompt = sys.argv[1], " ".join(sys.argv[2:])
    agent, mode = build_agent(access_token=os.environ.get("COGNITO_ACCESS_TOKEN"))
    user_text = f"[ks: {ks_id}]\n{prompt}"
    print(f"\n→ asking ({mode}): {prompt}\n")
    result = agent(user_text)
    print("\n=== ANSWER ===\n")
    print(result)


if __name__ == "__main__":
    main()
