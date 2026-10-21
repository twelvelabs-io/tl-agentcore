.PHONY: help check check-fast e2e e2e-chromium e2e-cross e2e-update-snapshots install deploy deploy-agent deploy-ui

help:
	@echo "tl-agentcore make targets:"
	@echo "  install              install ui deps + Playwright browsers"
	@echo "  check                full pre-deploy gate: chromium suite + cross-browser smoke"
	@echo "  check-fast           chromium-only suite (skips cross-browser smoke)"
	@echo "  e2e                  alias for 'check'"
	@echo "  e2e-chromium         chromium project only"
	@echo "  e2e-cross            firefox + webkit smoke only"
	@echo "  e2e-update-snapshots refresh visual-regression baselines"
	@echo "  deploy               full prod push: agent image + terraform apply + UI bundle + CF invalidate"
	@echo "  deploy-agent         only the runtime slice (ECR push + terraform apply with fresh tag)"
	@echo "  deploy-ui            only the UI slice (vite build + s3 sync + CF invalidate)"

install:
	cd ui && npm install
	cd ui && npx playwright install chromium firefox webkit

check: check-fast e2e-cross

check-fast:
	cd ui && npx playwright test --project=chromium

e2e: check

e2e-chromium:
	cd ui && npx playwright test --project=chromium

e2e-cross:
	cd ui && npx playwright test --project=firefox --project=webkit

e2e-update-snapshots:
	cd ui && npx playwright test e2e/24-visual-regression.spec.ts --project=chromium --update-snapshots

# ─── Deploy ──────────────────────────────────────────────────────────────
#
# `make deploy` fixes the partial-deploy footgun: pre-roadmap, you had to
# remember to run build-agent.sh, bump agent_image_tag in a terraform
# apply, rebuild the UI bundle, aws s3 sync it, and invalidate CloudFront
# in that order. Skipping any one of them silently breaks something — the
# recurring symptom was a working runtime behind a stale UI bundle
# ("Agent returned no text" when the SSE taxonomy changed).
#
# All five steps are now one target, with the same TAG string flowing
# into both ECR and terraform (via the `TAG=` env override that
# build-agent.sh now honors). terraform apply is NOT auto-approved — you
# still see the plan and confirm before mutation.
#
# Compute impact: ECR push (free tier), one AgentCore Runtime version
# bump, S3 PUTs, one CloudFront invalidation. Well under the $500/day
# notice threshold.

deploy: deploy-agent deploy-ui
	@echo "==> deploy: all steps complete."

deploy-agent:
	@TAG=v$$(date +%Y%m%d%H%M%S); \
	echo "==> deploy-agent: using TAG=$$TAG"; \
	TAG=$$TAG ./infra/build-agent.sh && \
	echo "==> deploy-agent: terraform apply -var agent_image_tag=$$TAG" && \
	terraform -chdir=infra apply -var agent_image_tag=$$TAG

deploy-ui:
	@echo "==> deploy-ui: npm ci (lockfile-pinned install so vite + friends match main)"
	cd ui && npm ci
	@echo "==> deploy-ui: vite build"
	cd ui && npm run build
	@BUCKET=$$(terraform -chdir=infra output -raw frontend_bucket); \
	DIST=$$(terraform -chdir=infra output -raw cloudfront_distribution_id); \
	echo "==> deploy-ui: aws s3 sync ui/dist/ -> s3://$$BUCKET/"; \
	aws s3 sync ui/dist/ s3://$$BUCKET/ --delete; \
	echo "==> deploy-ui: CloudFront invalidate $$DIST"; \
	aws cloudfront create-invalidation --distribution-id $$DIST --paths "/*" --query 'Invalidation.Id' --output text
