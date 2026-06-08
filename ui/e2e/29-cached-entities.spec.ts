import { test, expect, testConfig, selectKs } from "./fixtures";
import { captureAgentWs } from "./_ws-helper";

/** Phase 2 — kb_cache entity graph (cross-asset entity records).
 *
 * Test KS has one seeded ENTITY# record ("Big Buck Bunny", an animal kind
 * with 2 appearances). Asserts the agent reaches the cached entity-graph
 * tool — either list_cached_entities or find_cached_entity_appearances —
 * before falling through to retrieval. */

const ENTITY_GRAPH_TOOLS = new Set([
  "list_cached_entities",
  "find_cached_entity_appearances",
]);

test.describe("kb_cache entity graph", () => {
  test("Agent: 'who/what appears in this KB' fires a cached entity tool", async ({ signedInPage }) => {
    const cap = captureAgentWs(signedInPage);

    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });

    const ta = signedInPage.locator('textarea').first();
    await ta.click();
    await ta.pressSequentially(
      "What named entities (people, objects, characters) are tracked across this knowledge base?",
      { delay: 5 },
    );
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    const toolCall = await cap.waitFor(
      (ev) => ev.type === "tool_call" && typeof ev.tool === "string" && ENTITY_GRAPH_TOOLS.has(ev.tool),
      90_000,
    );
    expect(ENTITY_GRAPH_TOOLS.has(toolCall.tool as string)).toBe(true);

    await cap.waitFor(
      (ev) => ev.type === "tool_result" && typeof ev.tool === "string" && ENTITY_GRAPH_TOOLS.has(ev.tool),
      120_000,
    );

    let finalText = "";
    await cap.waitFor((ev) => {
      if (ev.type === "text_delta") finalText += String(ev.delta ?? "");
      return ev.type === "done";
    }, 180_000);

    // Seeded entity is "Big Buck Bunny" — agent should surface it by name.
    expect(finalText.toLowerCase()).toContain("big buck bunny");
  });
});
