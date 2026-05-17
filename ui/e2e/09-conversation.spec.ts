import { test, expect } from "./fixtures";

test.describe("RoughCut: conversational follow-up", () => {
  test("after a plan exists, follow-up turn produces a streamed agent response", async ({ signedInPage }) => {
    // Generate an initial plan so the chat thread is visible.
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Build me a tight 15-second highlight reel. Three beats: opener, action, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // Wait for the plan to render (timeline header) — this also confirms the
    // textarea has been swapped for the chat thread on the left.
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({
      timeout: 3 * 60_000,
    });

    // The conversation label should now be visible (chat replaces script).
    await expect(signedInPage.locator('text=§ I · Conversation').first()).toBeVisible();

    // The initial brief is visible as the first user message in the thread.
    await expect(
      signedInPage.locator('p:has-text("Build me a tight 15-second")').first()
    ).toBeVisible();

    // The agent's first response is visible (prose-only, plan-block stripped).
    const agentLabel = signedInPage.locator('text=Agent').first();
    await expect(agentLabel).toBeVisible();

    // Send a follow-up question that asks ABOUT a specific clip — the
    // intended path that should invoke pegasus_analyze on the agent side.
    // The test asserts the UI handles the streaming response; it does NOT
    // assert that pegasus_analyze was specifically called, since the agent
    // gets to choose.
    const followup = signedInPage.locator('textarea[placeholder*="ask the agent"]');
    await expect(followup).toBeVisible();
    await followup.fill("What is visually happening in scene 01 clip 01? Describe in one sentence.");
    await signedInPage.locator('button:has-text("send")').click();

    // A new agent bubble should appear and accumulate text. Wait up to 3
    // minutes (pegasus_analyze + Sonnet inference).
    await expect.poll(
      async () => {
        const all = await signedInPage.locator('text=Agent').count();
        return all;
      },
      { timeout: 3 * 60_000 }
    ).toBeGreaterThanOrEqual(2);

    // Once the second agent turn finishes, busy state clears and the send
    // button is enabled again with text "send →" (not "...").
    await expect(signedInPage.locator('button:has-text("send →")')).toBeVisible({ timeout: 3 * 60_000 });
  });

  test("the 'new cut' button resets the conversation and brings the script textarea back", async ({ signedInPage }) => {
    // Reuse the cached signed-in session from the previous test. The
    // history strip should still hold the plan from above; restore it so
    // the chat thread is loaded.
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();

    // Click the most recent history card (newest first) to restore.
    const historyCard = signedInPage.locator('div[style*="rgba(255, 122, 26"]').first();
    if (await historyCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await historyCard.click();
    } else {
      // No history; generate a small plan to set up.
      await signedInPage.locator("textarea").first().fill("Short reel: opener, action, close.");
      await signedInPage.locator('button:has-text("assemble rough cut")').click();
      await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({
        timeout: 3 * 60_000,
      });
    }

    // Chat thread should be live; click "+ new cut".
    const newCutBtn = signedInPage.locator('button:has-text("new cut")').first();
    await expect(newCutBtn).toBeVisible();
    await newCutBtn.click();

    // Now the script textarea should be back.
    await expect(signedInPage.locator('text=§ I · Script')).toBeVisible();
    await expect(signedInPage.locator('button:has-text("assemble rough cut")')).toBeVisible();
  });
});
