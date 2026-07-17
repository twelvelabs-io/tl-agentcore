import { test, expect, testConfig } from "./fixtures";
import { devices } from "@playwright/test";

/** Mobile-viewport regression. The SPA is desktop-first — its three
 *  tabs are a horizontal-rail layout and the KS picker is dense. Goal
 *  of this spec is to confirm the *crash-free* baseline on a mobile
 *  width: sign-in completes, the masthead renders, tab navigation
 *  works. We don't assert layout fidelity (that's design's call); we
 *  assert no JS errors and that the user can reach every primary
 *  surface. */

test.describe("Mobile viewport: crash-free baseline (iPhone 13)", () => {
  test("sign-in completes and the masthead is reachable", async ({ browser }) => {
    const context = await browser.newContext({ ...devices["iPhone 13"] });
    const errors: string[] = [];
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(testConfig.baseUrl);

    // v0.3+ replaced Hosted UI with an in-SPA SignInScreen. Drive it
    // on mobile too — same form shape, same submit selector.
    if (await page.locator('input[type="email"]').first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await page.locator('input[type="email"]').first().fill(testConfig.userEmail);
      await page.locator('input[type="password"]').first().fill(testConfig.userPassword);
      await page.locator('button[type="submit"]').first().click();
    }
    await expect(page.locator('h1', { hasText: "Rough Cut" })).toBeVisible({ timeout: 30_000 });

    // Tap each tab and confirm the tab click doesn't crash. Some tab
    // content has different labels/breakpoints on mobile (§ decorators
    // only render at wider viewports); assert the tab click landed by
    // checking the tab is visible + non-erroring.
    for (const label of ["Rough Cut", "Agent", "Library"]) {
      const tab = page.locator(`button.tab:has-text("${label}")`).first();
      await expect(tab).toBeVisible({ timeout: 10_000 });
      await tab.click();
      await page.waitForTimeout(500); // let the tab content mount
    }

    expect(errors, `JS errors on mobile: ${errors.join(" | ")}`).toHaveLength(0);
    await context.close();
  });
});
