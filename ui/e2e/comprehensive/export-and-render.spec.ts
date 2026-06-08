// EDL export + render preview submit/spinner + Download MP4 link.
// Render preview kicks off a real MediaConvert job — we wait for the
// SUBMITTED state and the spinner, NOT for the job to finish (that
// costs real $$ and time per run).

import { test, expect } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";
import {
  clickAssemble,
  pickTemplate,
  waitForPlan,
} from "./helpers/rough-cut";

test.describe("Rough Cut — export + render submit", () => {
  test("EDL download triggers a file save with the right extension", async ({ signedInPage }) => {
    await goToTab(signedInPage, "rough_cut");
    await selectKs(signedInPage, "Blender Open Movies");

    const newCut = signedInPage.locator('button:has-text("+ new cut")');
    if (await newCut.isVisible().catch(() => false)) await newCut.click();
    await pickTemplate(signedInPage, "highlight");
    await clickAssemble(signedInPage);
    await waitForPlan(signedInPage);

    const dlPromise = signedInPage.waitForEvent("download");
    await signedInPage.locator('button:has-text("Export EDL")').click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toMatch(/\.edl$/);
  });

  test("Render preview shows submitting then rendering state", async ({ signedInPage }) => {
    await goToTab(signedInPage, "rough_cut");
    await selectKs(signedInPage, "Blender Open Movies");

    // Reuse the plan from the previous test — if not present (test isolated)
    // generate the smallest possible one.
    const planHeader = signedInPage.getByText(/\d+ scenes? · \d+ clips?/).first();
    if (!(await planHeader.isVisible().catch(() => false))) {
      await pickTemplate(signedInPage, "highlight");
      await clickAssemble(signedInPage);
      await waitForPlan(signedInPage);
    }

    const renderBtn = signedInPage.locator('button:has-text("Render preview")');
    await renderBtn.click();
    // Submitting label appears within ~1s — the spinner is inline.
    await expect(signedInPage.locator('button:has-text("submitting")').or(signedInPage.locator('button:has-text("rendering")')))
      .toBeVisible({ timeout: 10_000 });
    // We don't wait for COMPLETE — that's a 30-60s MediaConvert run with
    // real cost. The state-transition itself is what we're testing.
  });
});
