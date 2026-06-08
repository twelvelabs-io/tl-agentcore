#!/usr/bin/env python3
"""Trigger the Phase 3-proper entity-Re-ID Step Functions pipeline for one KS.

The state machine fans out over every kb_cache-listed asset, runs the
GDINO+DeepSORT+Triton Processing Job per asset (GPU, ml.g5.xlarge by
default), Titan-embeds the resulting patch crops, and upserts vectors
into the entity-patches S3 Vectors index.

Usage:
  export ENTITY_REID_STATE_MACHINE_ARN=$(terraform -chdir=infra output -raw entity_reid_state_machine_arn)
  AWS_PROFILE=... python3 scripts/run_entity_reid_pipeline.py ks_<id> \\
      [--text-prompt "person."] [--fps 2.0] [--limit N] [--no-wait]

Prereqs (do these once before the first run):
  1. terraform apply — creates ECR repo, IAM, state machine, S3 Vectors index.
  2. Upload source zip:
       cd <repo-root>
       zip -r /tmp/gdino-src.zip agent/expert-models/gdino
       aws s3 cp /tmp/gdino-src.zip s3://<clips>/codebuild-src/gdino.zip
  3. Start the CodeBuild project to build + push the gdino image:
       aws codebuild start-build --project-name <codebuild_gdino_project_name>
       # Watch logs; the build prints `GDINO_IMAGE_TAG=v<ts>` at the end.
  4. If pinning to a specific tag (recommended for prod):
       terraform apply -var gdino_image_tag=v<ts>
  5. Run this script.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
STATE_MACHINE_ARN = os.environ.get("ENTITY_REID_STATE_MACHINE_ARN")

if not STATE_MACHINE_ARN:
    print("error: ENTITY_REID_STATE_MACHINE_ARN env var required", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ks_id", help="Knowledge store id (form: ks_xxxxxxxx)")
    ap.add_argument("--text-prompt", default="person.",
                    help='Period-separated GDINO prompt (default "person.")')
    ap.add_argument("--fps", type=float, default=2.0,
                    help="Frame extraction rate per asset (default 2.0)")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap how many cached assets to process (default: all)")
    ap.add_argument("--no-wait", action="store_true",
                    help="Fire-and-forget; print execution ARN and exit.")
    args = ap.parse_args()

    sfn = boto3.client("stepfunctions", region_name=REGION)

    # SF execution names must be unique per state machine; 80-char max,
    # alnum + -_= only. Use a short hex suffix for collision avoidance.
    short_ks = args.ks_id.replace("ks_", "")[:20]
    execution_name = f"erid-{short_ks}-{uuid.uuid4().hex[:8]}"

    payload = {
        "ks_id":       args.ks_id,
        "text_prompt": args.text_prompt,
        "fps":         args.fps,
        "limit":       args.limit,
    }
    print(f"→ starting execution {execution_name}")
    print(f"  state_machine: {STATE_MACHINE_ARN}")
    print(f"  input: {json.dumps(payload)}")

    resp = sfn.start_execution(
        stateMachineArn=STATE_MACHINE_ARN,
        name=execution_name,
        input=json.dumps(payload),
    )
    exec_arn = resp["executionArn"]
    print(f"  executionArn: {exec_arn}")

    if args.no_wait:
        print("→ --no-wait set; not polling")
        return 0

    print(f"→ polling until execution completes (Ctrl+C is safe — the SFN run continues)")
    t0 = time.time()
    while True:
        time.sleep(15)
        desc = sfn.describe_execution(executionArn=exec_arn)
        status = desc["status"]
        elapsed = int(time.time() - t0)
        print(f"  [{elapsed:>4}s] status: {status}")
        if status in ("SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"):
            break

    if desc["status"] != "SUCCEEDED":
        print(f"\n→ execution {desc['status']}", file=sys.stderr)
        if desc.get("cause"):
            print(f"  cause: {desc['cause'][:400]}", file=sys.stderr)
        if desc.get("error"):
            print(f"  error: {desc['error']}", file=sys.stderr)
        return 1

    output = json.loads(desc.get("output") or "{}")
    results = output.get("results") or []
    embedded = sum((r.get("embedded") or {}).get("patches_embedded", 0) for r in results)
    failed = sum(1 for r in results if r.get("status") == "failed")
    print(
        f"\n→ done · {len(results)} assets · "
        f"{embedded} patches embedded · {failed} failed · "
        f"{int(time.time() - t0)}s wall-clock"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
