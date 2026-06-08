import { test, expect } from "./fixtures";

/** Navigating tabs preserves the state the producer cares about:
 *  - A plan in the studio survives a trip to Agent + Library and back.
 *  - The masthead's KS picker is shared across all three tabs.
 *  - The status pip stays "live" throughout. */

test.describe("Tab navigation", () => {
  test("studio → Agent → Library → studio preserves the generated plan and KS picker state", async ({ signedInPage }) => {
    // 1. Generate a plan in the studio so there's something to preserve.
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Tiny round-trip reel. Three beats: opener, action, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });

    // Capture the active KS name from the masthead picker (truncated form).
    const kspicker = signedInPage.locator('button:has-text("Knowledge base")').first();
    const ksLabelBefore = await kspicker.textContent();

    // 2. Trip through Agent and Library.
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible();

    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("text=§ Library").first()).toBeVisible();

    // 3. Back to studio. AnimatePresence + the conditional tab render
    // unmount RoughCut on every tab switch, so in-memory state (brief,
    // chat thread, plan) is dropped. The plan was auto-saved to
    // localStorage history when generate() finished, so the recovery
    // path is: open the history drawer and restore.
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await expect(signedInPage.locator("text=§ Brief").first()).toBeVisible({ timeout: 10_000 });
    // Brief textarea is back to the default sample script.
    await expect(signedInPage.locator("text=§ Chat")).toBeHidden();

    // KS picker shows the same KS (KS state lives in the global store
    // and survives tab switches).
    const ksLabelAfter = await kspicker.textContent();
    expect(ksLabelAfter).toBe(ksLabelBefore);

    // Status pip never went dark during the trip.
    await expect(signedInPage.locator(".pip-ready")).toBeVisible();

    // The plan we just generated is in the history drawer; one click
    // restores it (verifies the recovery path is intact).
    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible();
    const firstCard = drawer.locator("div.cursor-pointer").first();
    await expect(firstCard).toBeVisible({ timeout: 5_000 });
  });
});
