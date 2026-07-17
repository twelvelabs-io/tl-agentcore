#!/usr/bin/env bash
# Install runtime deps for every lambda under ../lambda/*.
#
# The terraform stack's archive_file resources zip whatever's on disk
# in each lambda directory — including node_modules. On a fresh clone,
# node_modules/ doesn't exist, so the deploy zip ships only source
# files and every lambda that imports a third-party module (e.g.
# aws-jwt-verify, @aws-sdk/*) blows up at runtime with
# "Cannot find package …".
#
# Run this once after cloning + before `terraform apply`. Idempotent.

set -euo pipefail
cd "$(dirname "$0")/../lambda"

for d in */; do
  name="${d%/}"
  if [ ! -f "$d/package.json" ]; then
    echo "  · ${name}  no package.json — skipping"
    continue
  fi
  echo "==> ${name}"
  (cd "$d" && npm install --omit=dev --silent --no-audit --no-fund)
done

echo
echo "Done. Lambda deploy zips will now include node_modules on the next"
echo "terraform apply. Terraform will detect the archive hash change and"
echo "redeploy any lambda whose deps just landed for the first time."
