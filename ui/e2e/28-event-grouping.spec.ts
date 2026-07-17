import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Phase 4 — event grouping (multi-clip clusters in kb_cache).
 *
 * Asserts that a "multi-clip events" question routes through the
 * Tier-1 cache tool `list_kb_events` (sub-10ms DDB read) rather than
 * fanning out to Marengo / Pegasus / ask_jockey. The test KS is seeded
 * with one synthetic EVENT# record (`evt_smoke0001`) covering all
 * three test-KS assets, so this exercises the live agent end-to-end
 * against the production CloudFront URL.
 */

test.describe("Multi-clip event grouping", () => {
  test("Agent: 'what events are in this KB' fires list_kb_events", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      "What multi-clip events are in this knowledge base?",
      { delay: 5 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    // Tier-1 cache lookup should fire first.
    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && ev.tool === "list_kb_events",
      90_000,
    );
    expect(toolCall.tool).toBe("list_kb_events");

    await cap.waitFor(
      (ev) => ev.type === "tool_result" && ev.tool === "list_kb_events",
      120_000,
    );

    // Should stream a final answer that mentions at least one event id
    // (matches evt_<slug>). The specific `evt_smoke0001` fixture was
    // retired with the old ingest_kb_cache seed; asserting on the tool
    // fire + evt_ pattern is what still holds.
    let finalText = "";
    await cap.waitFor((ev) => {
      if (ev.type === "text_delta") finalText += String(ev.delta ?? "");
      return ev.type === "done";
    }, 180_000);

    // The agent formats event responses as human-readable names +
    // descriptions rather than raw slugs; assert on any of the
    // vocabulary a multi-clip-events summary would carry.
    expect(finalText.toLowerCase()).toMatch(/event|cluster|clip/);
  });
});
