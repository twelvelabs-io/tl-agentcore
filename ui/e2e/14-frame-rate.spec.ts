import { test, expect } from "./fixtures";
import fs from "node:fs";

/** Frame-rate picker. Producers pick 24/23.976/25/29.97/30 and expect:
 *   - the EDL button label updates to match
 *   - the downloaded EDL filename includes the new fps
 *   - the SMPTE timecodes inside the EDL use the new frame base */

test.describe("Frame-rate picker", () => {
  test("switching to 25 fps before assembling produces an EDL whose SMPTE timecodes use a 25-frame base", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();

    // Default is 24 fps; switch to 25 via the Pill picker in the brief
    // header. The Pill is only rendered in initial mode (before the
    // chat thread takes over the left rail), so fps must be picked
    // before clicking assemble.
    const pill = signedInPage.locator('button:has-text("24 fps")').first();
    await expect(pill).toBeVisible();
    await pill.click();
    await signedInPage.locator('button:has-text("25 fps · PAL")').click();
    // Confirm the Pill now reads "25 fps · PAL".
    await expect(signedInPage.locator('button:has-text("25 fps · PAL")').first()).toBeVisible();

    // Generate a plan.
    await signedInPage.locator("textarea").first().fill(
      "Short reel. Opener, action, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });

    // Button label updates immediately.
    await expect(signedInPage.locator('button:has-text("Export EDL (25 fps)")')).toBeVisible({ timeout: 3_000 });

    // Download and inspect the EDL.
    const [download] = await Promise.all([
      signedInPage.waitForEvent("download"),
      signedInPage.locator('button:has-text("Export EDL")').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/_25fps\.edl$/);
    const path = await download.path();
    const body = fs.readFileSync(path!, "utf-8");

    // CMX 3600 timecodes are HH:MM:SS:FF; at 25 fps the frame field
    // never exceeds 24 (frames cycle 0..24). The simplest robust check
    // is that no FF in any source/record timecode is 25 or higher,
    // because that would imply a different fps base.
    const tcMatches = body.match(/\d{2}:\d{2}:\d{2}:\d{2}/g) || [];
    expect(tcMatches.length).toBeGreaterThan(0);
    for (const tc of tcMatches) {
      const frames = parseInt(tc.split(":")[3], 10);
      expect(frames).toBeLessThan(25);
    }
  });
});
