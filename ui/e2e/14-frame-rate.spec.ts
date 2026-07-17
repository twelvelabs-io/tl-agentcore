import { test, expect } from "./fixtures";
import fs from "node:fs";

/** Frame-rate picker. Producers pick 24/23.976/25/29.97/30 and expect:
 *   - the EDL button label updates to match
 *   - the downloaded EDL filename includes the new fps
 *   - the SMPTE timecodes inside the EDL use the new frame base */

test.describe("Frame-rate picker", () => {
  test("switching to 25 fps before assembling produces an EDL whose SMPTE timecodes use a 25-frame base", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();

    // Set fps=25 via the Pill picker in the brief header. The Pill's
    // trigger text is the current fps (any of 24 / 23.976 / 25 / 29.97
    // / 30 depending on localStorage state) so match on the trailing
    // "fps ▼" arrow rather than a specific value. Idempotent: if
    // fps=25 is already active, clicking the option is a no-op.
    const pill = signedInPage.locator('button:has-text("fps"):has-text("▼")').first();
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await pill.click();
    const palOption = signedInPage.locator('button:has-text("25 fps · PAL")').first();
    await expect(palOption).toBeVisible({ timeout: 10_000 });
    await palOption.click();
    // Trigger should now read "25 fps ▼".
    await expect(signedInPage.locator('button:has-text("25 fps"):has-text("▼")').first()).toBeVisible();

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
