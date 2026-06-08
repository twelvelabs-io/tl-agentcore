import { test, expect } from "./fixtures";

/** Every close + manage path on the global history drawer. The drawer
 *  is reachable from any tab via the in-page "history" button. */

async function ensureAtLeastOneSavedCut(page: import("@playwright/test").Page) {
  // Open the drawer; if it has no entries, generate one quickly.
  await page.locator('button.tab:has-text("Rough Cut")').first().click();
  await page.locator('button:has-text("history")').first().click();
  const drawer = page.locator("aside.fixed");
  await expect(drawer).toBeVisible();
  const haveEntry = await drawer.locator("div.cursor-pointer").count();
  if (haveEntry > 0) {
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    return;
  }
  // No saved cuts; close drawer and generate one.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await page.locator("textarea").first().fill("Quick 10-second cut. Opener. Action. Closer.");
  await page.locator('button:has-text("assemble rough cut")').click();
  await expect(page.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });
}

test.describe("History drawer paths", () => {
  test("backdrop click closes the drawer", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible();
    // The backdrop is a fixed inset-0 z-40 div behind the drawer.
    await signedInPage.locator("div.fixed.inset-0.z-40").click({ position: { x: 20, y: 20 } });
    await expect(drawer).toBeHidden({ timeout: 5_000 });
  });

  test("× button in the drawer header closes the drawer", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible();
    await signedInPage.locator('button[aria-label="close history"]').click();
    await expect(drawer).toBeHidden({ timeout: 5_000 });
  });

  test("deleting an individual saved cut removes it from the drawer", async ({ signedInPage }) => {
    await ensureAtLeastOneSavedCut(signedInPage);
    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible();
    const cards = drawer.locator("div.cursor-pointer");
    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThan(0);
    // Click the × on the first card. The button text is the literal "×"
    // glyph inside a label-styled <button>.
    const firstCard = cards.first();
    await firstCard.locator('button[title="remove from history"]').click();
    await expect(cards).toHaveCount(initialCount - 1, { timeout: 5_000 });
  });

  test("restoring an agent-kind entry switches to the Agent tab and rehydrates", async ({ signedInPage }) => {
    // Clear prior-test history so this spec asserts against exactly one
    // freshly-saved agent entry (prior runs may have left stale entries
    // with no turns persisted, which would restore an empty thread).
    await signedInPage.evaluate(() => localStorage.removeItem("tl-agentcore.roughcut.history.v1"));
    await signedInPage.reload();

    // First, run a quick agent session so an agent-kind entry exists.
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible({ timeout: 10_000 });
    const askArea = signedInPage.locator("textarea").first();
    await askArea.click();
    await askArea.pressSequentially("Summarize this knowledge base in one sentence.", { delay: 5 });
    const submit = signedInPage.locator("button.btn-cue").first();
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();
    // Wait for response to land so the entry is persisted.
    await expect(signedInPage.locator('button:has-text("ask →")')).toBeVisible({ timeout: 3 * 60_000 });

    // New session to clear the thread.
    await signedInPage.locator('button:has-text("+ new session")').first().click();
    await expect(signedInPage.locator("text=§ Thread")).toBeHidden();

    // Sanity check the entry was actually persisted with the right kind
    // AND has turns recorded (an entry with no turns would restore to
    // an empty thread and falsely fail the assertion below).
    const stored = await signedInPage.evaluate(() => {
      const raw = localStorage.getItem("tl-agentcore.roughcut.history.v1");
      return raw ? JSON.parse(raw) : [];
    });
    const agentEntries = (stored as any[]).filter((e) => e.kind === "agent");
    expect(agentEntries.length).toBeGreaterThan(0);
    expect(agentEntries[0].turns?.length || 0).toBeGreaterThan(0);

    // Open the drawer; find an entry tagged "agent" and click it.
    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible();
    const agentEntry = drawer.locator('div[data-kind="agent"]').first();
    await expect(agentEntry).toBeVisible({ timeout: 5_000 });
    await agentEntry.click();

    // Drawer auto-closes on restore; we land back on the Agent tab and
    // the thread is repopulated.
    await expect(drawer).toBeHidden({ timeout: 5_000 });
    await expect(signedInPage.locator("text=§ Thread").first()).toBeVisible({ timeout: 5_000 });
  });
});
