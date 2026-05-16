import { test, expect } from "./fixtures";

test.describe("RoughCut: end-to-end plan generation", () => {
  test("typing a brief and clicking assemble yields a rendered plan", async ({ signedInPage }) => {
    // Activate the RoughCut tab if not already (it's the default).
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();

    // Type a short brief (small to keep agent latency in test budget).
    const textarea = signedInPage.locator("textarea").first();
    await textarea.fill(
      "A 20-second highlight reel. Cold open: one striking visual. " +
      "Middle beat: action. Closing beat: a held moment."
    );

    // Click the assemble button. The label includes an arrow.
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // Wait for the plan to render. The agent runs through Sonnet 4.6 +
    // Marengo per beat; allow up to 3 minutes.
    await expect(signedInPage.locator('text="scene"').first()).toBeVisible({
      timeout: 3 * 60_000,
    });

    // The timeline header shows total duration + scene count.
    await expect(signedInPage.locator('text=/\\d+ scenes? · \\d+ clips?/').first())
      .toBeVisible({ timeout: 30_000 });

    // The EDL export button appears once a plan lands.
    await expect(signedInPage.locator('button:has-text("Export EDL")')).toBeVisible();
  });
});
