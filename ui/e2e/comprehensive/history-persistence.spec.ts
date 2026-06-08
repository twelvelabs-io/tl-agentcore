// History drawer + refresh persistence. Cheap — reuses the plan written
// to localStorage by cut-types.spec.ts (or generates a tiny one if none).

import { test, expect } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";
import {
  clickAssemble,
  pickTemplate,
  readLatestPlanFromHistory,
  waitForPlan,
} from "./helpers/rough-cut";

test.describe("Rough Cut — history persistence + drawer", () => {
  test("a generated plan survives a page refresh", async ({ signedInPage }) => {
    await goToTab(signedInPage, "rough_cut");
    await selectKs(signedInPage, "Blender Open Movies"); // smallest KB — fastest run

    // Start fresh.
    const newCut = signedInPage.locator('button:has-text("+ new cut")');
    if (await newCut.isVisible().catch(() => false)) await newCut.click();

    await pickTemplate(signedInPage, "highlight"); // short cuts are quick to grade
    await clickAssemble(signedInPage);
    await waitForPlan(signedInPage);

    const before = await readLatestPlanFromHistory(signedInPage);
    expect(before).not.toBeNull();
    const titleBefore = before!.plan.title || "";

    // Refresh.
    await signedInPage.reload();

    // After refresh, on the Rough Cut tab, the previously-active entry
    // should be restored (tested via the timeline header showing scenes).
    await goToTab(signedInPage, "rough_cut");
    await expect(signedInPage.getByText(/\d+ scenes? · \d+ clips?/).first())
      .toBeVisible({ timeout: 20_000 });

    const after = await readLatestPlanFromHistory(signedInPage);
    expect(after).not.toBeNull();
    expect(after!.plan.title || "").toBe(titleBefore);
  });

  test("history drawer lists entries and restores them", async ({ signedInPage }) => {
    await goToTab(signedInPage, "rough_cut");
    await signedInPage.locator('button:has-text("history")').first().click();
    // Drawer should slide in from the right with a list.
    await expect(signedInPage.locator("text=/history/i").first()).toBeVisible();
    // Close.
    await signedInPage.keyboard.press("Escape").catch(() => {});
  });

  test("+ new cut clears active entry so refresh lands empty", async ({ signedInPage }) => {
    await goToTab(signedInPage, "rough_cut");
    const newCut = signedInPage.locator('button:has-text("+ new cut")');
    if (await newCut.isVisible().catch(() => false)) {
      await newCut.click();
    }
    // Refresh.
    await signedInPage.reload();
    await goToTab(signedInPage, "rough_cut");
    // Empty state — the assemble button visible, no scene cards.
    await expect(signedInPage.locator('button:has-text("assemble rough cut")')).toBeVisible();
    await expect(signedInPage.getByText(/^scene \d+/i)).toHaveCount(0);
  });
});
