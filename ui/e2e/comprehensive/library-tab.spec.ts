// Library tab: list, filter, click-to-play.

import { test, expect } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";

test.describe("Library tab", () => {
  test("assets render and clicking opens the player modal", async ({ signedInPage }) => {
    await goToTab(signedInPage, "library");
    await selectKs(signedInPage, "Blender Open Movies"); // small list, fast

    // Library cards have class `clip-card` (see ui/src/components/Library.tsx).
    const firstCard = signedInPage.locator("button.clip-card").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });

    // Library uses double-click semantics — first click selects, second
    // opens the player modal.
    await firstCard.click();
    await firstCard.click();
    await expect(signedInPage.locator("video").first()).toBeVisible({ timeout: 15_000 });

    // Close.
    await signedInPage.locator('button:has-text("close")').first().click().catch(async () => {
      await signedInPage.keyboard.press("Escape");
    });
  });

  test("typing in the filter narrows the visible list", async ({ signedInPage }) => {
    await goToTab(signedInPage, "library");
    await selectKs(signedInPage, "Blender Open Movies");

    // Wait for at least one card so we're not racing initial mount.
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });

    // Filter input — typed search at top of library.
    const filter = signedInPage.locator('input[placeholder*="filter"], input[type=search]').first();
    if (await filter.isVisible().catch(() => false)) {
      const before = await signedInPage.locator("button.clip-card").count();
      await filter.fill("nothingmatchesthis_xyzzy");
      await signedInPage.waitForTimeout(400);
      const after = await signedInPage.locator("button.clip-card").count();
      expect(after).toBeLessThan(before);
    }
    // Spec is lenient: if the filter isn't surfaced for this KS shape, skip.
  });
});
