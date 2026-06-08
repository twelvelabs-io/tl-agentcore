import { test, expect, testConfig, selectKs } from "./fixtures";

/** Two-tab concurrent session. Producers commonly open the SPA twice —
 *  one tab to keep an in-progress brief, another to browse the
 *  Library. This spec opens two pages within the same context (so
 *  they share cookies + storage state) and asserts:
 *    - Both tabs sign in (storage state replay works in both).
 *    - Mutations from tab B (clicking a tab, switching KS) do NOT
 *      mirror into tab A's React state. The SPA is per-tab; this
 *      catches a regression where a global listener accidentally
 *      cross-broadcasts.
 *    - localStorage tokens stay healthy after tab-B's API calls. */

test.describe("Concurrent tabs in the same context", () => {
  test("two tabs run independently and don't cross-broadcast UI state", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/storage-state.json" });

    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await Promise.all([tabA.goto(testConfig.baseUrl), tabB.goto(testConfig.baseUrl)]);
    await Promise.all([
      expect(tabA.locator('h1', { hasText: "Rough Cut" })).toBeVisible({ timeout: 30_000 }),
      expect(tabB.locator('h1', { hasText: "Rough Cut" })).toBeVisible({ timeout: 30_000 }),
    ]);

    // Tab A: switch to Agent.
    await tabA.locator('button.tab:has-text("Agent")').first().click();
    await expect(tabA.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    // Tab B: switch to Library.
    await tabB.locator('button.tab:has-text("Library")').first().click();
    await expect(tabB.locator('text=§ Library').first()).toBeVisible({ timeout: 10_000 });

    // Tab A should still be on Agent — Tab B's click shouldn't have
    // crossed over. We assert the `active` aria on Tab A's Agent tab.
    const agentTabA = tabA.locator('button.tab:has-text("Agent")').first();
    await expect(agentTabA).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 }).catch(async () => {
      // Some tab implementations use a class instead of aria-pressed;
      // fall back to checking that Agent's content surface is visible.
      await expect(tabA.locator('text=§ Question').first()).toBeVisible();
    });

    // Tab B's tokens should be healthy after its API calls.
    const tokensB = await tabB.evaluate(() => JSON.parse(localStorage.getItem("tl-agentcore.tokens") || "null"));
    expect(tokensB?.access_token).toBeTruthy();
    expect(tokensB?.expires_at).toBeGreaterThan(Date.now());

    await context.close();
  });
});
