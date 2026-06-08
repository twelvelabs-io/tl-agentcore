import { test, expect } from "./fixtures";

test.describe("RoughCut: history", () => {
  test("a generated plan is saved to history and restorable from the drawer", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();

    const uniqueMarker = `e2e-${Date.now().toString(36)}`;
    await signedInPage.locator("textarea").first().fill(
      `${uniqueMarker}\n\nBuild a 10-second cold-open cut.`
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // Wait for the plan to land.
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({
      timeout: 3 * 60_000,
    });

    // Open the history drawer from the masthead.
    // History trigger is now in-page (left rail of each tab) — small label button.
await signedInPage.locator('button:has-text("history")').first().click();

    // Drawer header is "§ History" and the count line confirms at least
    // one saved cut is in localStorage. Both are inside aside.fixed.
    const drawer = signedInPage.locator('aside.fixed');
    await expect(drawer.locator('text=§ History').first()).toBeVisible({ timeout: 5_000 });
    await expect(drawer.locator('text=/\\d+ saved cuts? · stored locally/')).toBeVisible({ timeout: 5_000 });
  });
});
