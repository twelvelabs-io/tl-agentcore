import { test, expect } from "./fixtures";

test.describe("RoughCut: alternates render + swap", () => {
  test("each clip exposes a Marengo-ranked alternates strip", async ({ signedInPage }) => {
    // Reuse the same generate flow as 03 but assert on alternates.
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Build me a tight 15-second action highlight. Three beats: setup, hit, aftermath."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // Wait for at least one alternate toggle to render. The toggle reads
    // "▸ N alternates · marengo-ranked".
    const altToggle = signedInPage
      .locator('button:has-text("alternates · marengo-ranked")')
      .first();
    await expect(altToggle).toBeVisible({ timeout: 3 * 60_000 });

    // The toggle text encodes the alt count; assert it's at least 1.
    const toggleText = (await altToggle.textContent()) || "";
    const m = toggleText.match(/(\d+)\s+alternates?/);
    expect(m).not.toBeNull();
    const count = m ? Number(m[1]) : 0;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("clicking an alternate swaps it into the primary slot", async ({ signedInPage }) => {
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Build me a tight 15-second action highlight. Three beats: setup, hit, aftermath."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    const altToggle = signedInPage
      .locator('button:has-text("alternates · marengo-ranked")')
      .first();
    await expect(altToggle).toBeVisible({ timeout: 3 * 60_000 });

    // Open the alternates strip on the first clip that has them.
    await altToggle.click();

    // The strip renders 1+ rows with a "use this →" button. Grab the
    // primary clip's filename slice BEFORE the swap so we can verify
    // it moves down into the alts.
    const useThisBtn = signedInPage.locator('button:has-text("use this")').first();
    await expect(useThisBtn).toBeVisible({ timeout: 10_000 });

    // Find the clip-card containing this toggle, capture its primary
    // filename text, swap, then assert the primary changed.
    const clipCard = altToggle.locator('xpath=ancestor::li[contains(@class,"clip-card")]').first();
    const primaryLine = clipCard.locator("div.font-mono.text-xs").first();
    const before = (await primaryLine.textContent()) || "";

    await useThisBtn.click();

    // After the swap, the primary line text should differ. We poll because
    // the React state update + re-render isn't instant.
    await expect.poll(
      async () => (await primaryLine.textContent()) || "",
      { timeout: 5_000 }
    ).not.toBe(before);
  });
});
