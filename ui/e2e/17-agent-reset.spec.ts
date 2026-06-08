import { test, expect } from "./fixtures";

/** Agent tab — the "+ new session" button discards the current thread
 *  and brings the suggestion list back. Producers depend on this to
 *  reset a runaway session without reloading the page. */

test.describe("Agent tab: + new session", () => {
  test("running a question, then clicking + new session clears the thread and brings suggestions back", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible({ timeout: 10_000 });

    // Send one question so a thread + the + new session button exist.
    const textarea = signedInPage.locator("textarea").first();
    await textarea.click();
    await textarea.pressSequentially("In one sentence: what is in this knowledge base?", { delay: 5 });
    const submit = signedInPage.locator("button.btn-cue").first();
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();

    // Wait for the agent to finish (send button text returns to "ask →").
    await expect(signedInPage.locator('button:has-text("ask →")')).toBeVisible({ timeout: 3 * 60_000 });
    await expect(signedInPage.locator('text=§ Thread')).toBeVisible();

    // Click + new session.
    const reset = signedInPage.locator('button:has-text("+ new session")').first();
    await expect(reset).toBeVisible();
    await reset.click();

    // Thread section is gone; suggestions reappear (Suggestions block shows "Try").
    await expect(signedInPage.locator('text=§ Thread')).toBeHidden({ timeout: 5_000 });
    await expect(signedInPage.locator('text=Try').first()).toBeVisible();
  });
});
