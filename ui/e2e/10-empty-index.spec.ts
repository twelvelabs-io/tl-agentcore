import { test, expect, selectKs } from "./fixtures";

/** Regression guard for the prose-only first-turn path.
 *
 * When the active KS has no vector index, the agent (correctly) replies in
 * prose explaining the situation. Earlier versions of generate() threw
 * "Error: Agent didn't return a parseable <plan>JSON</plan> block" in that
 * case - real bug that the existing E2E suite never caught because it only
 * targeted the populated test KS. This spec exercises the empty path
 * directly and asserts the UI now renders gracefully.
 *
 * The static TEST_EMPTY_KS_ID fixture is no longer reliable — v0.4's demo
 * KSes are all populated. Each test now creates a scratch empty KS via
 * the SPA's create-KS flow and cleans it up in afterEach. */

async function createEmptyKs(page: any): Promise<string> {
  // Handle both picker states: empty-fleet (no KSes yet) shows a bare
  // "+ create your first knowledge base" button; populated shows the
  // "Knowledge base" dropdown with "+ New knowledge store" at the
  // bottom. Wait for either shape to be visible.
  const emptyFleetBtn = page.locator('button:has-text("+ create your first knowledge base")').first();
  const pickerBtn = page.locator('button:has-text("Knowledge base")').first();
  await Promise.race([
    emptyFleetBtn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
    pickerBtn.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
  ]);
  if (await emptyFleetBtn.isVisible().catch(() => false)) {
    await emptyFleetBtn.click();
  } else {
    await pickerBtn.click();
    const newBtn = page.locator('button:has-text("+ New knowledge store")').first();
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();
  }

  // Form appears in-place. The name input has autoFocus so it's already
  // focused; wait for it to be attached before typing.
  const nameInput = page.locator('input[placeholder^="Name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  const uniqueName = `e2e-empty-${Date.now()}`;
  await nameInput.fill(uniqueName);
  await page.locator('button:has-text("create")').first().click();

  // handleCreated does setState({ksList, ks}); the picker re-renders
  // with the new KS as active.
  await expect(page.locator(`button:has-text("Knowledge base") >> text=${uniqueName}`).first())
    .toBeVisible({ timeout: 15_000 });
  return uniqueName;
}

test.describe("Empty-index path", () => {
  test("selecting an unindexed KS and submitting a brief yields prose-only, not a UI error", async ({ signedInPage }) => {
    // Create + activate a fresh scratch KS (guaranteed empty).
    await createEmptyKs(signedInPage);

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
    // Fresh scratch KS + run the empty-index flow to populate the chat.
    await createEmptyKs(signedInPage);
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill("Build a 10-second reel.");
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.locator('text=§ Chat').first()).toBeVisible({
      timeout: 3 * 60_000,
    });
    // The follow-up textarea should be visible + enabled even though no
    // plan exists (previously the chat layout was gated on plan != null).
    const followup = signedInPage.locator('textarea[placeholder*="ask the agent"]').first();
    await expect(followup).toBeVisible({ timeout: 5_000 });
    await expect(followup).toBeEnabled();
  });
});
