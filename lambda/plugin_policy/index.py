"""Reference AgentCore Gateway Lambda target: distribution policy.

Exposes one MCP tool to the agent:

  requirements_for(territory, asset_type?)  — the artifacts a given
                                              territory needs before an
                                              asset can be distributed

This is the "what's missing?" piece of Distribution-Readiness. The
agent uses it to tell the exec: "to ship this to Germany you also
need German subtitles, poster_de, trailer_de; you have 2 of 3."

Policies are owned by the per-stack `plugin_policies` DDB table
(hash key: territory). Each row's `required` field is a list of
required artifact labels, optionally grouped by asset_type.

Terraform seeds a few reasonable defaults; customers overwrite this
table (or swap this plugin for one that hits their own compliance
system) to reflect their own distribution rules.
"""
import os
import boto3

_ddb = boto3.client("dynamodb")
POLICIES_TABLE = os.environ["POLICIES_TABLE"]


def _from_ddb(v):
    if v is None:
        return None
    if "S"    in v: return v["S"]
    if "N"    in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "NULL" in v: return None
    if "L"    in v: return [_from_ddb(x) for x in v["L"]]
    if "M"    in v: return {k: _from_ddb(x) for k, x in v["M"].items()}
    if "SS"   in v: return list(v["SS"])
    return None


def _requirements_for(args):
    territory = (args.get("territory") or "").strip().upper()
    asset_type = (args.get("asset_type") or "").strip().lower()
    if not territory:
        return {"error": "territory (string) is required"}

    # Policy rows are keyed by territory; DEFAULT applies when the
    # requested territory has no row of its own.
    row = None
    for key in (territory, "DEFAULT"):
        r = _ddb.get_item(TableName=POLICIES_TABLE, Key={"territory": {"S": key}})
        if r.get("Item"):
            row = r["Item"]
            applied = key
            break
    if row is None:
        return {
            "territory":    territory,
            "found":        False,
            "message":      "No distribution policy on file for this territory and no DEFAULT configured.",
            "requirements": [],
        }

    data = {k: _from_ddb(v) for k, v in row.items()}
    required = data.get("required") or []

    # When caller filtered by asset_type, overlay the type-specific
    # requirements on top. Row shape: `by_asset_type.<type>` → extra
    # list.
    extra = []
    if asset_type:
        by_type = data.get("by_asset_type") or {}
        if isinstance(by_type, dict):
            extra = by_type.get(asset_type) or []

    merged = list(required) + [r for r in extra if r not in required]

    return {
        "territory":       territory,
        "applied_policy":  applied,       # DEFAULT if we fell through
        "asset_type":      asset_type or None,
        "found":           True,
        "requirements":    merged,
        "notes":           data.get("notes"),
    }


_TOOLS = {
    "requirements_for": _requirements_for,
}


def handler(event, context):
    # AgentCore Gateway lambda-target contract (observed 2026-10-23):
    #   event              = raw tool arguments at top level
    #   context.client_context.custom["bedrockAgentCoreToolName"]
    #                      = "<target-name>___<tool-name>"
    full_name = ""
    cc = getattr(context, "client_context", None)
    if cc is not None:
        custom = getattr(cc, "custom", None) or {}
        full_name = custom.get("bedrockAgentCoreToolName") or ""
    tool = full_name.split("___", 1)[1] if "___" in full_name else full_name
    args = event if isinstance(event, dict) else {}
    fn = _TOOLS.get(tool)
    if not fn:
        return {"error": f"unknown tool: {tool!r} (full={full_name!r})"}
    try:
        return fn(args)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
