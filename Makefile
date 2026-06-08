.PHONY: help check check-fast e2e e2e-chromium e2e-cross e2e-update-snapshots install

help:
	@echo "tl-agentcore make targets:"
	@echo "  install              install ui deps + Playwright browsers"
	@echo "  check                full pre-deploy gate: chromium suite + cross-browser smoke"
	@echo "  check-fast           chromium-only suite (skips cross-browser smoke)"
	@echo "  e2e                  alias for 'check'"
	@echo "  e2e-chromium         chromium project only"
	@echo "  e2e-cross            firefox + webkit smoke only"
	@echo "  e2e-update-snapshots refresh visual-regression baselines"

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
