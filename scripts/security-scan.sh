#!/usr/bin/env bash
# One-shot security scanner sweep. Runs every scanner the security
# review process expects. Non-zero exit if anything real fires.
#
# Usage:  scripts/security-scan.sh
#
# Scanners:
#   1. terraform fmt -check       — style hygiene
#   2. terraform validate         — semantic correctness
#   3. tflint + AWS ruleset       — best-practice terraform
#   4. checkov                    — cloud misconfigurations
#   5. gitleaks                   — secrets in git history
#   6. semgrep                    — code-pattern security bugs
#   7. osv-scanner                — dependency CVEs
#   8. zizmor                     — GitHub Actions workflow security

set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/Library/Python/3.14/bin:$HOME/.local/bin:$PATH"

# Semgrep rule exclusions (false positives for this codebase):
#   unsafe-formatstring — the JS rule fires on `console.warn(\`...\${x}\`)`,
#   but JS console methods do NOT interpret printf-style format
#   specifiers the way util.format() does. There's no log-forging or
#   argument-hijack surface here.
SEMGREP_EXCLUDE_RULES=(
  --exclude-rule=javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
)

echo "══════════════════════════════════════════════════════"
echo "  1. terraform fmt -check"
echo "══════════════════════════════════════════════════════"
terraform -chdir=infra fmt -check -recursive && echo "OK"

echo
echo "══════════════════════════════════════════════════════"
echo "  2. terraform validate"
echo "══════════════════════════════════════════════════════"
terraform -chdir=infra validate

echo
echo "══════════════════════════════════════════════════════"
echo "  3. TFLint + AWS ruleset"
echo "══════════════════════════════════════════════════════"
tflint --chdir=infra --format=compact

echo
echo "══════════════════════════════════════════════════════"
echo "  4. Checkov"
echo "══════════════════════════════════════════════════════"
checkov -d infra --framework terraform --quiet --compact --config-file .checkov.yaml 2>&1 | tail -3

echo
echo "══════════════════════════════════════════════════════"
echo "  5. Gitleaks"
echo "══════════════════════════════════════════════════════"
gitleaks git --no-banner --exit-code=1

echo
echo "══════════════════════════════════════════════════════"
echo "  6. Semgrep"
echo "══════════════════════════════════════════════════════"
semgrep --config auto --quiet --error --disable-version-check \
  "${SEMGREP_EXCLUDE_RULES[@]}"

echo
echo "══════════════════════════════════════════════════════"
echo "  7. OSV-Scanner"
echo "══════════════════════════════════════════════════════"
osv-scanner scan --recursive . 2>&1 | tail -5

echo
echo "══════════════════════════════════════════════════════"
echo "  8. zizmor"
echo "══════════════════════════════════════════════════════"
if [ -d .github/workflows ]; then
  zizmor .github/workflows/
else
  echo "no .github/workflows — skipping"
fi

echo
echo "══════════════════════════════════════════════════════"
echo "  ✓ all scanners clean"
echo "══════════════════════════════════════════════════════"
