import { test, expect, testConfig } from "./fixtures";

/** Regression guard for the prose-only first-turn path.
 *
 * When the active KS has no vector index, the agent (correctly) replies in
 * prose explaining the situation. Earlier versions of generate() threw
 * "Error: Agent didn't return a parseable <plan>JSON</plan> block" in that
 * case - real bug that the existing E2E suite never caught because it only
 * targeted the populated test KS. This spec exercises the empty path
 * directly and asserts the UI now renders gracefully. */

test.describe("Empty-index path", () => {
  test("selecting an unindexed KS and submitting a brief yields prose-only, not a UI error", async ({ signedInPage }) => {
    // Switch the active KS to the empty fixture via the masthead picker.
    const picker = signedInPage.locator('button:has-text("Knowledge base")').first();
    await expect(picker).toBeVisible();
    await picker.click();
    // Dropdown opens; click the row whose id matches the empty KS.
    const emptyOption = signedInPage.locator(`button:has-text("${testConfig.emptyKsId}")`).first();
    await expect(emptyOption).toBeVisible({ timeout: 5_000 });
    await emptyOption.click();

    // Submit a brief.
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Build me a 10-second highlight reel. Three quick beats: opener, hit, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // The conversation should appear (chat replaces the textarea once any
    // turn has fired, even without a plan).
    await expect(signedInPage.locator('text=§ Chat').first()).toBeVisible({
      timeout: 3 * 60_000,
    });

    // The agent's prose response is visible in the chat thread.
    const agentLabel = signedInPage.locator('text=Agent').first();
    await expect(agentLabel).toBeVisible();

    // The empty-state placeholder shows on the timeline side.
    await expect(
      signedInPage.locator('[data-testid="no-plan-placeholder"]')
    ).toBeVisible({ timeout: 60_000 });

    // No "Error:" prefix bubbling up to the user.
    await expect(
      signedInPage.locator('pre:has-text("Error: Agent didn\'t return")')
    ).toHaveCount(0);
    await expect(
      signedInPage.locator('text=Agent didn\'t return a parseable')
    ).toHaveCount(0);

    // The agent's reply mentions the remediation script so the producer
    // knows what to do next.
    const bodyText = (await signedInPage.locator("main").textContent()) || "";
    expect(bodyText).toMatch(/ingest_vectors|embedding index|not been populated|not been built/i);
  });

  test("after the empty-KS prose response, the follow-up input is enabled (producer can keep talking)", async ({ signedInPage }) => {
    // Reuse the prior session via storage state; the previous spec left the
    // chat thread visible. Re-open the RoughCut tab.
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();

    // The follow-up textarea should be visible and enabled even though no
    // plan exists. (Previously the chat layout was gated on plan != null,
    // hiding the input on the empty-index path.)
    const followup = signedInPage.locator('textarea[placeholder*="ask the agent"]').first();
    if (await followup.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(followup).toBeEnabled();
    } else {
      // If storage state didn't preserve the messages thread, re-run the
      // empty-index path to populate it, then assert.
      const picker = signedInPage.locator('button:has-text("Knowledge base")').first();
      await picker.click();
      const emptyOption = signedInPage.locator(`button:has-text("${testConfig.emptyKsId}")`).first();
      await emptyOption.click();
      await signedInPage.locator("textarea").first().fill("Build a 10-second reel.");
      await signedInPage.locator('button:has-text("assemble rough cut")').click();
      await expect(signedInPage.locator('text=§ Chat').first()).toBeVisible({
        timeout: 3 * 60_000,
      });
      const followup2 = signedInPage.locator('textarea[placeholder*="ask the agent"]').first();
      await expect(followup2).toBeEnabled();
    }
  });
});
