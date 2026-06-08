"""One-shot: invoke the asset_profile lambda once per existing assets row
that doesn't yet have an ASSET#<asset_id> entry in kb_cache.

Going forward, asset_profile fires automatically on the S3 ObjectCreated
event for any new clips/<asset_id>.mp4 (wired in upload-lambda.tf). This
script just covers the assets that already existed when the trigger was
attached — they need a manual kick.

Idempotent: skips any asset whose kb_cache ASSET# row already exists.
Bounded concurrency so we don't blow Pegasus 1.2 rate limits.

Usage:
    AWS_PROFILE=TLSolProd python scripts/backfill_asset_profiles.py [--only ks_demo02-blender-open-movies] [--concurrency 4]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
STACK = os.environ.get("STACK", "tl-agentcore-1c323e")
ASSETS_TABLE = f"{STACK}-assets"
KB_CACHE_TABLE = f"{STACK}-kb-cache"
CLIPS_BUCKET = f"{STACK}-clips"
LAMBDA_NAME = f"{STACK}-asset-profile"

ddb = boto3.client("dynamodb", region_name=REGION)
# Lambda invocations can take up to the asset_profile timeout (300 s);
# default boto3 read-timeout is 60 s, which trips on slower Pegasus runs.
lam = boto3.client(
    "lambda",
    region_name=REGION,
    config=Config(read_timeout=360, connect_timeout=10, retries={"max_attempts": 3}),
)


def list_assets(only_ks: str | None) -> list[tuple[str, str]]:
    """Returns (asset_id, ks_id) tuples."""
    rows = []
    last = None
    while True:
        kw = dict(TableName=ASSETS_TABLE, ProjectionExpression="asset_id,knowledge_store_id")
        if last: kw["ExclusiveStartKey"] = last
        out = ddb.scan(**kw)
        for it in out.get("Items", []):
            aid = it.get("asset_id", {}).get("S")
            ks = it.get("knowledge_store_id", {}).get("S")
            if not aid or not ks:
                continue
            if only_ks and ks != only_ks:
                continue
            rows.append((aid, ks))
        last = out.get("LastEvaluatedKey")
        if not last:
            break
    return rows


def has_profile(ks_id: str, asset_id: str, require_field: str | None = None) -> bool:
    """Returns True if the asset has a profile and (optionally) ALSO has the
    named field populated. When `require_field` is set, an asset whose ASSET#
    row exists but lacks that field reads as "needs re-profile" — useful for
    re-running after the prompt is extended to emit new keys (e.g. when we
    added `skip_ranges` to PROFILE_PROMPT)."""
    kwargs = {
        "TableName": KB_CACHE_TABLE,
        "Key": {"pk": {"S": f"ks#{ks_id}"}, "sk": {"S": f"ASSET#{asset_id}"}},
    }
    if require_field and require_field != "asset_id":
        kwargs["ProjectionExpression"] = "asset_id, #f"
        kwargs["ExpressionAttributeNames"] = {"#f": require_field}
    else:
        kwargs["ProjectionExpression"] = "asset_id"
    r = ddb.get_item(**kwargs)
    item = r.get("Item")
    if not item:
        return False
    if require_field and require_field != "asset_id":
        return require_field in item
    return True


def invoke_lambda(asset_id: str) -> tuple[bool, str]:
    fake_event = {
        "Records": [{
            "s3": {
                "bucket": {"name": CLIPS_BUCKET},
                "object": {"key": f"clips/{asset_id}.mp4"},
            }
        }]
    }
    try:
        # Synchronous — the lambda takes 30-90 s for Pegasus to run.
        r = lam.invoke(
            FunctionName=LAMBDA_NAME,
            InvocationType="RequestResponse",
            Payload=json.dumps(fake_event).encode("utf-8"),
        )
        body = r.get("Payload").read().decode("utf-8")
        if r.get("FunctionError"):
            return False, f"function error: {body[:200]}"
        return True, body[:80]
    except ClientError as e:
        return False, f"invoke error: {e}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="KS id to limit the backfill to.")
    ap.add_argument("--concurrency", type=int, default=4, help="Concurrent lambda invocations.")
    ap.add_argument("--limit", type=int, default=0, help="Cap on assets processed (0 = all).")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--require-field",
        default=None,
        help=(
            "Only profile assets whose ASSET# row is missing this field. "
            "Use e.g. --require-field skip_ranges to backfill the new "
            "credits/black tagging on already-profiled assets."
        ),
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help=(
            "Re-profile every asset regardless of cache state. Use after "
            "editing PROFILE_PROMPT so existing profiles pick up the new "
            "fields / schema."
        ),
    )
    args = ap.parse_args(argv[1:])

    print(f"scanning {ASSETS_TABLE} …")
    rows = list_assets(args.only)
    print(f"  {len(rows)} candidate assets")

    todo = []
    for aid, ks in rows:
        if not args.force and has_profile(ks, aid, require_field=args.require_field):
            continue
        todo.append((aid, ks))
    if args.force:
        print(f"  --force: re-profiling all {len(todo)} assets regardless of cache state")
    else:
        gate = f" with `{args.require_field}` populated" if args.require_field else ""
        print(f"  {len(todo)} need profiles{gate} (the rest are already cached)")

    if args.limit:
        todo = todo[: args.limit]
        print(f"  capped to {len(todo)} for this run")

    if args.dry_run:
        for aid, ks in todo[:10]:
            print(f"  · would profile {aid} ({ks})")
        return 0

    ok = err = 0
    start = time.time()
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = {ex.submit(invoke_lambda, aid): (aid, ks) for (aid, ks) in todo}
        for fut in as_completed(futures):
            aid, ks = futures[fut]
            success, msg = fut.result()
            if success:
                ok += 1
            else:
                err += 1
                print(f"  ! {aid}: {msg}")
            if (ok + err) % 25 == 0:
                elapsed = time.time() - start
                rate = (ok + err) / elapsed * 60
                remaining = (len(todo) - ok - err) / max(rate / 60, 0.01)
                print(f"  [{ok + err}/{len(todo)}] ok={ok} err={err} rate≈{rate:.0f}/min remaining≈{remaining/60:.1f} min")
    elapsed = time.time() - start
    print(f"\ndone — {ok} profiled / {err} errored in {elapsed/60:.1f} min")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
