import { test, expect, type Page } from "./fixtures";

/** The agent classifies every follow-up as informational, structural,
 *  or ambiguous (system prompt §CONVERSATION MODE). Informational
 *  replies are prose-only and the plan stays put; structural replies
 *  emit a fresh <plan> block that the UI parses onto the timeline.
 *  This spec exercises both shapes via observable side effects on the
 *  persisted plan in localStorage. */

async function readActivePlan(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("tl-agentcore.roughcut.history.v1");
    if (!raw) return null;
    const arr = JSON.parse(raw) as any[];
    const cut = arr.find((e) => e.kind === "rough_cut");
    return cut?.plan ?? null;
  });
}

async function sendFollowup(page: Page, text: string) {
  const fu = page.locator('textarea[placeholder*="ask the agent"]').first();
  await fu.click();
  await fu.pressSequentially(text, { delay: 5 });
  await page.locator('button:has-text("send →")').click();
  // After send, busy is true and the "agent thinking…" label appears
  // under the textarea. Wait for that to disappear (agent finished),
  // then for the "⌘↩ to send" hint to come back. Not using the cue
  // button's enabled state because it stays disabled while the
  // textarea is empty regardless of busy.
  await expect(page.locator('text=agent thinking…')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('text=agent thinking…')).toBeHidden({ timeout: 3 * 60_000 });
}

test.describe("Plan classification", () => {
  test("informational follow-up leaves the plan untouched; structural follow-up rewrites it", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Tight reel with three beats: opener, action, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });

    const initialPlan = await readActivePlan(signedInPage);
    expect(initialPlan).not.toBeNull();
    const initialScenes = initialPlan.scenes.length;
    expect(initialScenes).toBeGreaterThanOrEqual(2);

    // Informational: ask about content. Expect prose-only reply.
    await sendFollowup(signedInPage, "Describe scene 1 clip 1 in one sentence.");
    const afterInfo = await readActivePlan(signedInPage);
    expect(afterInfo.scenes.length).toBe(initialScenes);
    // The same first-scene first-clip asset_id should be unchanged.
    expect(afterInfo.scenes[0].clips[0].video_reference)
      .toBe(initialPlan.scenes[0].clips[0].video_reference);

    // Structural: drop a scene. Expect plan to shrink.
    await sendFollowup(signedInPage, "Drop the last scene; keep only the first two.");
    const afterStructural = await readActivePlan(signedInPage);
    expect(afterStructural.scenes.length).toBeLessThan(initialScenes);
  });
});
