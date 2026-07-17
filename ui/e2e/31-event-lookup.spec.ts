import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Phase 4 — single-event lookup via lookup_event(event_id).
 *
 * Complements spec 28 (which exercises list_kb_events). This spec asserts
 * the agent can pivot from a known event_id to the full record. */

test.describe("Single-event lookup", () => {
  test("Agent: 'tell me about <event>' fires lookup_event", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    // The old `evt_smoke0001` fixture was retired with the ingest_kb_cache
    // seed. Pick whatever event actually exists in this KS: hit list_kb_events
    // first, then pivot on the event_id it returns.
    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      "Call list_kb_events to see what events exist, then call lookup_event on the first one to fetch its full record.",
      { delay: 5 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && ev.tool === "lookup_event",
      120_000,
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

    // Response should mention an event id or the word "event".
    expect(finalText.toLowerCase()).toMatch(/evt_[a-z0-9_]+|event/);
  });
});
