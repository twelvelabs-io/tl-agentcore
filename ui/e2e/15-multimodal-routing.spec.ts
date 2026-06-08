import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Retrieval routing — proves the agent reaches for at least one
 *  retrieval/cache tool on a search-shaped question. Under the Jockey-shaped
 *  agent (cache-first), `list_kb_assets`/`get_kb_overview` may fire before
 *  (or instead of) `vector_search`/`marengo_search`. This spec asserts that
 *  the agent uses *some* retrieval primitive — not a specific one. */

const RETRIEVAL_TOOLS = new Set([
  "vector_search",       // tier 0 (S3 Vectors)
  "marengo_search",      // tier 2 (TL /search)
  "list_kb_assets",      // tier 1 (cache)
  "get_kb_overview",     // tier 1 (cache)
  "lookup_asset_profile",// tier 1 (cache)
]);

test.describe("Retrieval routing", () => {
  test("Agent: a search-shaped query reaches a retrieval/cache tool", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially("Which clips have spoken dialogue about the antagonist?", { delay: 5 });
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    // Wait for the runtime to emit any retrieval/cache tool_call.
    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && typeof ev.tool === "string" && RETRIEVAL_TOOLS.has(ev.tool),
      90_000,
    );
    expect(RETRIEVAL_TOOLS.has(toolCall.tool as string)).toBe(true);

    // And the corresponding tool_result.
    await cap.waitFor(
      (ev) => ev.type === "tool_result" && typeof ev.tool === "string" && RETRIEVAL_TOOLS.has(ev.tool),
      120_000,
    );

    // The streamed answer should land before the loop terminates.
    await cap.waitFor((ev) => ev.type === "done", 180_000);
  });
});
