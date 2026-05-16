import { test, expect } from "./fixtures";

test.describe("RoughCut: EDL export", () => {
  test("clicking Export EDL triggers a CMX 3600 download", async ({ signedInPage }) => {
    await signedInPage.locator('button:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Three-shot reel: cold open, action, coda. Each beat 5 seconds."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();

    // Wait for the export button to enable (only present once plan lands).
    const exportBtn = signedInPage.locator('button:has-text("Export EDL")');
    await expect(exportBtn).toBeVisible({ timeout: 3 * 60_000 });

    const [download] = await Promise.all([
      signedInPage.waitForEvent("download"),
      exportBtn.click(),
    ]);

    const filename = download.suggestedFilename();
    expect(filename).toMatch(/\.edl$/i);

    const stream = await download.createReadStream();
    let bytes = "";
    if (stream) {
      for await (const chunk of stream) bytes += chunk.toString();
    }
    // CMX 3600 starts with TITLE: and includes FCM:
    expect(bytes).toContain("TITLE:");
    expect(bytes).toContain("FCM:");
  });
});
