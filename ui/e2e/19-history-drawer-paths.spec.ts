import { test, expect } from "./fixtures";

/** Every close + manage path on the global history drawer. The drawer
 *  is reachable from any tab via the in-page "history" button. */

async function ensureAtLeastOneSavedCut(page: import("@playwright/test").Page) {
  // Unconditionally plant a synthetic history entry. Live plan
  // generation would need 60-180 s of real Bedrock calls and can be
  // brittle on small KSes; the drawer render + delete UI is what the
  // test really cares about.
  //
  // No page.reload — the drawer's useEffect on `open` re-reads
  // localStorage every time it opens, so we don't need to bounce the
  // page. Also, reload risks losing the Cognito auth state on some
  // browsers and would force a re-sign-in.
  await page.locator('button.tab:has-text("Rough Cut")').first().click();
  const planted = await page.evaluate(() => {
    const key = "tl-agentcore.roughcut.history.v1";
    const existing = (() => {
      try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
    })();
    const entry = {
      id: `e2e-${Date.now()}`,
      kind: "rough_cut",
      created_at: Date.now(),
      title: "e2e history-drawer test entry",
      script: "e2e history-drawer test",
      fps: 24,
      plan: { title: "e2e", scenes: [{ scene_id: "01", scene_name: "e2e", clips: [] }] },
      messages: [],
    };
    const list = [entry, ...existing];
    localStorage.setItem(key, JSON.stringify(list));
    return list.length;
  });
  if (planted === 0) throw new Error("failed to plant history entry — localStorage set-and-read returned empty");
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
    // Diagnostic: confirm localStorage holds the planted entry.
    const localCount = await signedInPage.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("tl-agentcore.roughcut.history.v1") || "[]").length;
      } catch { return -1; }
    });
    console.log(`localStorage history entry count: ${localCount}`);
    expect(localCount).toBeGreaterThan(0);

    await signedInPage.locator('button:has-text("history")').first().click();
    const drawer = signedInPage.locator("aside.fixed");
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    // Drawer entries state hydrates from localStorage inside a
    // useEffect that runs after the first render, so on cold open the
    // cards briefly count 0 before the second render lands. Wait
    // (with polling) for the first card to become visible before
    // measuring — count() alone doesn't retry.
    const cards = drawer.locator('[data-kind="rough_cut"], [data-kind="agent"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await cards.count();
    console.log(`drawer card count: ${initialCount}`);
    expect(initialCount).toBeGreaterThan(0);
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
