import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Phase 3-pragma — find_entity_by_image (Titan Multimodal + S3 Vectors).
 *
 * Uses one of the thumbnails ingest_entity_thumbs.py produced as the
 * reference image. Should return the source asset at near-1.0 score
 * (self-match) plus the rest of the entity-thumbs index ranked by
 * cosine similarity. */

const REFERENCE_URL = "s3://tl-agentcore-1c323e-clips/thumbs/6a0900c85a237763f2bc2aec/2.jpg";

test.describe("AWS-native Re-ID-style image search", () => {
  test("Agent: 'find visually similar clips to this image' fires find_entity_by_image", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      `Use find_entity_by_image with reference_url='${REFERENCE_URL}' to find visually-similar clips in this KB.`,
      { delay: 3 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && ev.tool === "find_entity_by_image",
      90_000,
    );
    expect(toolCall.tool).toBe("find_entity_by_image");

    await cap.waitFor(
      (ev) => ev.type === "tool_result" && ev.tool === "find_entity_by_image",
      180_000,
    );

    let finalText = "";
    await cap.waitFor((ev) => {
      if (ev.type === "text_delta") finalText += String(ev.delta ?? "");
      return ev.type === "done";
    }, 240_000);

    // Self-match should surface the source asset_id at the top.
    expect(finalText).toContain("6a0900c85a237763f2bc2aec");
  });
});
