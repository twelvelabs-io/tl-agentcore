import { test, expect } from "./fixtures";

/** Keyboard shortcuts that producers expect to "just work":
 *   - ⌘↩ in the chat follow-up textarea sends the message
 *   - ⌘↩ in the Agent ask textarea sends the question
 *   - Escape closes the History drawer regardless of focus
 *
 *  Each assertion is shallow on purpose; we only confirm the key
 *  binding still fires, not the downstream agent response. */

test.describe("Keyboard shortcuts", () => {
  test("Agent tab: ⌘↩ in the ask textarea fires send", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible({ timeout: 10_000 });

    const textarea = signedInPage.locator("textarea").first();
    await textarea.click();
    await textarea.pressSequentially("Quick keyboard test.", { delay: 5 });
    // Press ⌘↩ (Meta+Enter) — Playwright maps Meta on macOS, Control on others.
    const isMac = process.platform === "darwin";
    await textarea.press(isMac ? "Meta+Enter" : "Control+Enter");

    // After firing, busy state triggers the "..." label on the cue button
    // and the textarea is cleared.
    await expect(textarea).toHaveValue("", { timeout: 5_000 });
  });

  test("RoughCut chat: ⌘↩ in the follow-up textarea fires send", async ({ signedInPage }) => {
    // Need a plan first so the chat textarea is rendered.
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Short reel. Three beats: opener, hit, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });

    // The chat follow-up textarea is now rendered.
    const followup = signedInPage.locator('textarea[placeholder*="ask the agent"]').first();
    await expect(followup).toBeVisible();
    await followup.click();
    await followup.pressSequentially("describe scene 1 clip 1 in one sentence.", { delay: 5 });
    const isMac = process.platform === "darwin";
    await followup.press(isMac ? "Meta+Enter" : "Control+Enter");

    // Send fires → textarea clears.
    await expect(followup).toHaveValue("", { timeout: 5_000 });
  });

  test("Escape closes the History drawer from any tab", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    // Open the drawer via the in-page history button.
    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible();
    await signedInPage.keyboard.press("Escape");
    await expect(drawer).toBeHidden({ timeout: 5_000 });
  });
});
