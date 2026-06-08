import { test, expect, testConfig, selectKs } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";

/** axe-core accessibility audits across the five primary views. We
 *  scan against WCAG 2.1 AA + best-practice rules and tolerate a small
 *  allowlist of violations that come from third-party widgets (the
 *  Cognito Hosted UI form, embedded HLS player controls). Each view's
 *  baseline is the absence of *new* serious/critical issues — the spec
 *  fails on any axe-detected `serious` or `critical` violation outside
 *  the allowlist. */

const ALLOWLIST_IDS = new Set<string>([
  // The Hosted UI form is owned by Cognito; we don't control its DOM.
  "duplicate-id",
  "duplicate-id-aria",
  // hls.js inserts its own video controls without labels.
  "video-caption",
]);

async function scan(page: any, label: string) {
  // The SPA cross-fades tabs with framer-motion. Running axe mid-fade
  // makes ancestor opacity skew the computed contrast on descendant
  // text (effective color = fg * opacity over bg). Wait until the
  // motion settles — every visible element has opacity 1 — before
  // scanning. 1.2 s is well beyond the 0.3 s framer transition.
  await page.waitForTimeout(1200);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();

  const blocking = results.violations.filter((v) => {
    if (ALLOWLIST_IDS.has(v.id)) return false;
    return v.impact === "critical" || v.impact === "serious";
  });

  if (blocking.length) {
    const summary = blocking
      .map((v) => {
        const targets = v.nodes.slice(0, 5).map((n) => {
          const sel = Array.isArray(n.target) ? n.target.join(" ") : String(n.target);
          // axe attaches a `failureSummary` per node with the
          // computed colors / expected ratio. Surface the first line.
          const fs = (n.failureSummary || "").split("\n").slice(0, 2).join(" ").trim();
          return `    ${sel}${fs ? `  // ${fs}` : ""}`;
        }).join("\n");
        return `[${v.impact}] ${v.id}: ${v.description}\n  ${v.nodes.length} node(s)\n${targets}`;
      })
      .join("\n");
    throw new Error(`a11y violations on ${label}:\n${summary}`);
  }
}

test.describe("axe-core accessibility scans", () => {
  test("RoughCut tab is free of serious/critical violations", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await expect(signedInPage.locator('text=§ Brief')).toBeVisible({ timeout: 10_000 });
    await scan(signedInPage, "RoughCut");
  });

  test("Agent tab is free of serious/critical violations", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });
    await scan(signedInPage, "Agent");
  });

  test("Library tab is free of serious/critical violations", async ({ signedInPage }) => {
    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });
    await scan(signedInPage, "Library");
  });

  test("History drawer is free of serious/critical violations", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator('button:has-text("History")').first().click();
    await expect(signedInPage.locator('text=§ History').first()).toBeVisible({ timeout: 5_000 });
    await scan(signedInPage, "History drawer");
  });
});
