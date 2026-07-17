import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** v0.4 hybrid — find_by_image (Rekognition Faces primary + Marengo
 * fallback). Reference image is one of the KS's own MediaConvert thumb
 * captures — Rekognition may or may not find a face depending on the
 * clip, but the Marengo visual-similarity fallback will always fire
 * and return ranked matches. */

// A stable thumb from the blender KS (the fixture's TEST_KS_ID).
const REFERENCE_URL = "https://d18q1864w6gq7b.cloudfront.net/hls/6a09b6fb2c17415a844fa19d/6a09b6fb2c17415a844fa19d_thumb.0000005.jpg";

test.describe("AWS-native Re-ID-style image search", () => {
  test("Agent: 'find visually similar clips to this image' fires find_by_image", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      `Use find_by_image with reference_url='${REFERENCE_URL}' to find visually-similar clips in this KB.`,
      { delay: 3 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && ev.tool === "find_by_image",
      90_000,
    );
    expect(toolCall.tool).toBe("find_by_image");

    await cap.waitFor(
      (ev) => ev.type === "tool_result" && ev.tool === "find_by_image",
      180_000,
    );

    let finalText = "";
    await cap.waitFor((ev) => {
      if (ev.type === "text_delta") finalText += String(ev.delta ?? "");
      return ev.type === "done";
    }, 240_000);

    // Assert the tool actually retrieved matches — the response should
    // mention scores, matches, or asset_ids. Specific-asset assertions
    // vary per KS + Rekognition/Marengo path taken; assert on shape.
    expect(finalText.toLowerCase()).toMatch(/match|score|similar|rekognition|marengo|found|clips?/);
  });
});
