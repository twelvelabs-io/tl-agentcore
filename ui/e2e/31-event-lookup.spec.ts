import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Phase 4 — single-event lookup via lookup_event(event_id).
 *
 * Complements spec 28 (which exercises list_kb_events). This spec asserts
 * the agent can pivot from a known event_id to the full record. */

test.describe("Single-event lookup", () => {
  test("Agent: 'tell me about evt_smoke0001' fires lookup_event", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      "Tell me about event evt_smoke0001 — use lookup_event to get the full record.",
      { delay: 5 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && ev.tool === "lookup_event",
      90_000,
    );
    expect(toolCall.tool).toBe("lookup_event");

    await cap.waitFor(
      (ev) => ev.type === "tool_result" && ev.tool === "lookup_event",
      120_000,
    );

    let finalText = "";
    await cap.waitFor((ev) => {
      if (ev.type === "text_delta") finalText += String(ev.delta ?? "");
      return ev.type === "done";
    }, 180_000);

    // Seeded event description mentions "triptych" — should surface in answer.
    expect(finalText.toLowerCase()).toMatch(/triptych|nature|jellyfish|snow/);
  });
});
