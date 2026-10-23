// Distribution-Readiness card: Agent tab renders `<distribution_card>`
// as a structured card.
//
// Drives the deployed agent → Gateway → plugin tools → card emission →
// UI parse → render path end-to-end. Costs one agent turn (~$0.03-0.05)
// per run. Post-PR 9 the recipe is plugin-shape-agnostic: whichever
// capability plugins happen to be registered on this stack feed the
// corresponding card sections, absent capabilities render as empty with
// a `(no X source)` sentinel. The test only asserts the structural
// invariants that must hold regardless: the card shell, the Policy
// section header, and the Data sources section header (always rendered
// post-PR 9 since the agent always emits a `data_sources` array).
import { test, expect } from "./fixtures";
import { goToTab, selectKs } from "./comprehensive/helpers/nav";

test.describe("Distribution-Readiness card", () => {
  test("agent emits <distribution_card> and the UI renders it", async ({ signedInPage }) => {
    await goToTab(signedInPage, "agent");
    await selectKs(signedInPage, "Hollywood Trailers");

    const ta = signedInPage.locator("textarea").first();
    await ta.fill("Can I distribute to Germany? Give me a readiness report with policy and audience fit.");
    await ta.press("Meta+Enter").catch(async () => {
      await ta.press("Control+Enter");
    });

    // Card shell lands within 3 min (agent fans out whichever capability
    // tools match, then per-asset lookups).
    const card = signedInPage.locator('[data-testid="distribution-card"]').first();
    await expect(card).toBeVisible({ timeout: 180_000 });

    // Section headers that are always rendered regardless of which
    // plugins are deployed: Policy (empty when no policy source matched;
    // the renderer prints "no deliverables required" rather than
    // hiding), and Data sources (post-PR 9 the agent always emits the
    // array, so the section always shows).
    await expect(card.locator("text=/§ Policy/i")).toBeVisible();
    await expect(card.locator("text=/§ Data sources/i")).toBeVisible();

    // Regression guard: the raw JSON must NOT leak into the markdown
    // prose underneath (stripStructuredBlocks in vref.tsx handles this).
    // `.response-md` is the ReactMarkdown wrapper; its text content must
    // not contain the `<distribution_card>` tag or the `applied_policy`
    // JSON key.
    const prose = signedInPage.locator(".response-md").first();
    const proseText = await prose.textContent();
    expect(proseText || "").not.toMatch(/<distribution_card>/i);
    expect(proseText || "").not.toMatch(/"applied_policy"/i);
  });
});
