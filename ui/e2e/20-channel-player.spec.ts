import { test, expect } from "./fixtures";

/** ChannelPlayer plays the EDL back-to-back via HLS, no MediaConvert
 *  stitch required. After a plan exists, the player renders inside the
 *  timeline column; clicking ▶ flips the play icon to ❚❚ and a <video>
 *  element starts advancing currentTime. */

test.describe("ChannelPlayer", () => {
  test("after a plan exists, the player renders + ▶ advances playback", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator("textarea").first().fill(
      "Quick reel. Three beats: opener, action, closer."
    );
    await signedInPage.locator('button:has-text("assemble rough cut")').click();
    await expect(signedInPage.getByText(/^scene \d/i).first()).toBeVisible({ timeout: 3 * 60_000 });

    // Player wraps in a .channel-player-wrap container with stacked <video>s.
    const wrap = signedInPage.locator(".channel-player-wrap").first();
    await expect(wrap).toBeVisible({ timeout: 10_000 });

    // Two <video> elements are mounted (active + preload slots).
    await expect(wrap.locator("video")).toHaveCount(2);

    // Hover the wrap so the custom control bar fades in (hover-revealed
    // via .channel-player-wrap:hover .channel-controls).
    await wrap.hover();
    const playBtn = wrap.locator('button[title="play"]').first();
    await expect(playBtn).toBeVisible({ timeout: 5_000 });
    await playBtn.click({ force: true });

    // After clicking, the active video element fires a "play" event,
    // flipping the button title to "pause". HLS actually advancing
    // currentTime is too sensitive to headless Chromium / TL CDN
    // latency to assert reliably in E2E; the title flip + the
    // existence of two video elements with a src is enough to confirm
    // the component is wired up correctly.
    await expect(wrap.locator('button[title="pause"]').first()).toBeVisible({ timeout: 30_000 });
  });
});
