import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Per-clip analysis — proves the agent reaches a per-clip content tool
 *  when asked to describe what's in a specific clip. Under the Jockey-
 *  shaped agent (cache-first), `lookup_asset_profile` answers most
 *  "what is this clip" questions straight from the kb_cache one_liner
 *  + mood_tags; `pegasus_analyze` is only invoked when the cached
 *  profile is missing or insufficient. This spec asserts that EITHER
 *  tool fires — both legitimately answer the user's question. */

// Any of these counts as "the agent reached for a per-clip analysis tool."
// `lookup_asset_profile` and `pegasus_analyze` are the original pair;
// `get_content_profile` is the Jockey-named alias of `lookup_asset_profile`
// added in PR #25; `zoom_in_video` is the time-windowed Pegasus wrapper
// (PR #25) that the SYSTEM_PROMPT now prefers for "describe what's happening
// in these frames" style questions.
const PER_CLIP_TOOLS = new Set([
  "pegasus_analyze",
  "lookup_asset_profile",
  "get_content_profile",
  "zoom_in_video",
]);

test.describe("Per-clip analysis tool", () => {
  test("Agent: a clip-content question triggers pegasus_analyze or lookup_asset_profile", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      "Pick one clip from the knowledge base and describe what is happening visually in the frames — camera angles, subject motion, lighting.",
      { delay: 5 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    // Either per-clip analysis tool counts as success.
    const analysisCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && typeof ev.tool === "string" && PER_CLIP_TOOLS.has(ev.tool),
      180_000,
    );
    expect(PER_CLIP_TOOLS.has(analysisCall.tool as string)).toBe(true);

    await cap.waitFor((ev) => ev.type === "done", 240_000);
  });
});
