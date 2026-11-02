import { test, expect } from "./fixtures";

/** Keyboard shortcuts that producers expect to "just work":
 *   - Enter in the chat follow-up composer sends the message
 *   - Enter in the Agent ask composer sends the question
 *   - Escape closes the History drawer regardless of focus
 *
 *  (The composers are React Bits' PromptBar — Enter sends, Shift+Enter
 *  inserts a newline, matching standard chat UX.)
 *
 *  Each assertion is shallow on purpose; we only confirm the key
 *  binding still fires, not the downstream agent response. */

test.describe("Keyboard shortcuts", () => {
  test("Agent tab: Enter in the ask composer fires send", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible({ timeout: 10_000 });

    const textarea = signedInPage.locator("textarea").first();
    await textarea.click();
    await textarea.pressSequentially("Quick keyboard test.", { delay: 5 });
    await textarea.press("Enter");

    // After firing, the composer clears.
    await expect(textarea).toHaveValue("", { timeout: 5_000 });
  });

  test("RoughCut chat: Enter in the follow-up composer fires send", async ({ signedInPage }) => {
    // Need a plan first so the chat composer is rendered.
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Short reel. Three beats: opener, hit, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });

    // The chat follow-up composer is now rendered.
    const followup = signedInPage.locator('textarea[placeholder*="ask the agent"]').first();
    await expect(followup).toBeVisible();
    await followup.click();
    await followup.pressSequentially("describe scene 1 clip 1 in one sentence.", { delay: 5 });
    await followup.press("Enter");

    // Send fires → composer clears.
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
