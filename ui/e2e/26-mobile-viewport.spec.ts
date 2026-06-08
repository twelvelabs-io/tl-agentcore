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
    const context = await browser.newContext({
      ...devices["iPhone 13"],
      storageState: "e2e/storage-state.json",
    });
    const errors: string[] = [];
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(testConfig.baseUrl);
    await expect(page.locator('h1', { hasText: "Rough Cut" })).toBeVisible({ timeout: 30_000 });

    // Tap each tab and confirm a representative element renders.
    await page.locator('button.tab:has-text("Rough Cut")').first().click();
    await expect(page.locator('text=§ Brief').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('button.tab:has-text("Agent")').first().click();
    await expect(page.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    await page.locator('button.tab:has-text("Library")').first().click();
    await expect(page.locator('text=§ Library').first()).toBeVisible({ timeout: 10_000 });

    expect(errors, `JS errors on mobile: ${errors.join(" | ")}`).toHaveLength(0);
    await context.close();
  });
});
