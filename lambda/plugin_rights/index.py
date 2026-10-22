"""Reference AgentCore Gateway Lambda target: rights management.

Exposes two MCP tools to the agent:

  lookup_rights(asset_id, region?)        — licensing + clearance for one asset
  list_cleared_assets(territory, as_of?)  — inverted: all assets with rights
                                            that include `territory` on `as_of`

Reads RIGHTS_TABLE (hash key: asset_id). Same table the in-proc
version read — no data migration. See
agent/tl_agentcore/agent.py:lookup_rights for the row shape.

`list_cleared_assets` is new in the plugin surface; it's the "give me
every asset I can ship to Germany next week" query the exec needs.
"""
import os
from datetime import datetime, timezone

import boto3

_ddb = boto3.client("dynamodb")
RIGHTS_TABLE = os.environ["RIGHTS_TABLE"]


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
    if "NS"   in v: return [float(n) if "." in n else int(n) for n in v["NS"]]
    return None


def _row(item):
    return {k: _from_ddb(v) for k, v in item.items()}


def _parse_iso(s):
    if not isinstance(s, str) or not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _window_contains(window, as_of_dt, territory_up):
    region = str(window.get("region") or "").upper()
    if region != territory_up and region != "GLOBAL":
        return False
    start = _parse_iso(window.get("window_start") or window.get("start"))
    end   = _parse_iso(window.get("window_end")   or window.get("end"))
    if start and as_of_dt < start:
        return False
    if end and as_of_dt > end:
        return False
    return True


# ─── tool: lookup_rights ───────────────────────────────────────────────
def _lookup_rights(args):
    asset_id = args.get("asset_id")
    region   = args.get("region")
    if not isinstance(asset_id, str) or not asset_id:
        return {"error": "asset_id (string) is required"}

    r = _ddb.get_item(TableName=RIGHTS_TABLE, Key={"asset_id": {"S": asset_id}})
    item = r.get("Item")
    if not item:
        return {
            "asset_id": asset_id,
            "found":    False,
            "message":  "No rights record on file. Treat as 'unknown — verify with rights management before use.'",
        }
    row = _row(item)
    rights = row.get("rights") or []
    if region:
        r_up = region.upper()
        rights = [w for w in rights if (str(w.get("region") or "").upper() == r_up or w.get("region") == "GLOBAL")]
    return {
        "asset_id":          asset_id,
        "found":             True,
        "title":             row.get("title"),
        "rights":            rights,
        "talent_clearances": row.get("talent_clearances") or [],
    }


# ─── tool: list_cleared_assets ─────────────────────────────────────────
def _list_cleared_assets(args):
    territory = (args.get("territory") or "").strip().upper()
    as_of     = args.get("as_of")
    if not territory:
        return {"error": "territory (string) is required"}
    as_of_dt = _parse_iso(as_of) if as_of else datetime.now(timezone.utc)
    if as_of_dt is None:
        return {"error": f"as_of must be ISO-8601, got {as_of!r}"}

    cleared = []
    kwargs = {"TableName": RIGHTS_TABLE}
    while True:
        r = _ddb.scan(**kwargs)
        for item in r.get("Items", []):
            row     = _row(item)
            windows = row.get("rights") or []
            hits    = [w for w in windows if _window_contains(w, as_of_dt, territory)]
            if hits:
                cleared.append({
                    "asset_id": row.get("asset_id"),
                    "title":    row.get("title"),
                    "windows":  hits,
                })
        if "LastEvaluatedKey" not in r:
            break
        kwargs["ExclusiveStartKey"] = r["LastEvaluatedKey"]

    return {
        "territory":   territory,
        "as_of":       as_of_dt.isoformat(),
        "count":       len(cleared),
        "assets":      cleared,
    }


# ─── dispatcher ────────────────────────────────────────────────────────
_TOOLS = {
    "lookup_rights":       _lookup_rights,
    "list_cleared_assets": _list_cleared_assets,
}


def handler(event, _context):
    tool = event.get("tool")
    args = event.get("arguments") or {}
    fn = _TOOLS.get(tool)
    if not fn:
        return {"error": f"unknown tool: {tool!r}"}
    try:
        return fn(args)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
