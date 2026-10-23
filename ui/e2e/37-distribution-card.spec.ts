// Distribution-Readiness card: Agent tab renders `<distribution_card>`
// as a structured card.
//
// Drives the deployed agent → Gateway → plugin tools → card emission →
// UI parse → render path end-to-end. Costs one agent turn (~$0.03-0.05)
// per run. The seeded `plugin_policies` DDB table has DE / JP / BR /
// DEFAULT rows (see infra/plugin-policy-target.tf), so the policy
// section always renders; the assets/audience sections may be empty if
// the stack doesn't have rights/audience rows populated — the test
// tolerates that and only asserts the card shell + policy section
// render, which is enough to prove the wire holds.
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

    // Card shell lands within 2 min (agent fans out three plugin calls
    // in parallel, then lookup_asset_profile per candidate).
    const card = signedInPage.locator('[data-testid="distribution-card"]').first();
    await expect(card).toBeVisible({ timeout: 180_000 });

    // Section headers landed. The policy section always has content —
    // DE is seeded in Terraform — so look for a few known deliverables.
    await expect(card.locator("text=/§ Policy/i")).toBeVisible();
    await expect(card.locator("text=/video|poster/i").first()).toBeVisible();

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
