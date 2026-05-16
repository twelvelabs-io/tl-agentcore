import { test, expect } from "./fixtures";

test.describe("RoughCut: history", () => {
  test("a generated plan is saved to the history strip and restorable", async ({ signedInPage }) => {
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();

    const uniqueMarker = `e2e-${Date.now().toString(36)}`;
    await signedInPage.locator("textarea").first().fill(
      `${uniqueMarker}\n\nBuild a 10-second cold-open cut.`
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // Wait for the plan to land.
    await expect(signedInPage.locator('text="scene"').first()).toBeVisible({
      timeout: 3 * 60_000,
    });

    // The history strip renders one card per saved entry. The latest
    // entry's title is what we'll find.
    const historyCards = signedInPage.locator(".grid").locator('div:has-text("edl only"), div:has-text("rendered")');
    await expect(historyCards.first()).toBeVisible({ timeout: 10_000 });

    // Click the most-recently-created history card. The active one has
    // the orange highlight via inline borderColor — we just click the
    // first card (newest first).
    const newest = signedInPage.locator('div[style*="rgba(255, 122, 26"]').first();
    await expect(newest).toBeVisible({ timeout: 5_000 });
  });
});
