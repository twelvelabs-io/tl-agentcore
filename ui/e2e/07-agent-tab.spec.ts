import { test, expect } from "./fixtures";

test.describe("Agent tab", () => {
  test("switching to the Agent tab renders the tool catalog and live diagram", async ({ signedInPage }) => {
    await signedInPage.locator('button:has-text("Agent")').first().click();

    // Tool catalog rail.
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible();
    await expect(signedInPage.locator("text=pegasus_analyze").first()).toBeVisible();
    await expect(signedInPage.locator("text=list_tl_indexes").first()).toBeVisible();

    // Live arch diagram is present (AgentCore Runtime is the hero card).
    await expect(signedInPage.locator('text="AgentCore Runtime"').first()).toBeVisible();
  });

  test("Jockey is not mentioned anywhere on the Agent tab", async ({ signedInPage }) => {
    await signedInPage.locator('button:has-text("Agent")').first().click();
    // Wait for the page to settle (LiveArchDiagram pulls all node names).
    await signedInPage.locator('text="AgentCore Runtime"').first().waitFor();
    const body = (await signedInPage.locator("body").textContent()) || "";
    expect(body.toLowerCase()).not.toContain("jockey");
  });

  test("sending a short question yields a streamed text response", async ({ signedInPage }) => {
    await signedInPage.locator('button:has-text("Agent")').first().click();

    // Use the textarea on the Agent page.
    const textarea = signedInPage.locator("textarea").first();
    await textarea.fill("Summarize what's in this knowledge base in one sentence.");

    // The submit button is labelled with an arrow / "send" depending on
    // state. The button is visually the orange CTA on the input row.
    await signedInPage.locator('button.btn-cue').first().click();

    // Streaming responses surface as <p> updates under § II. Wait for
    // ANY text to land. Agent turns take 30-120 s.
    const responseRegion = signedInPage.locator(".response-md").first();
    await expect(responseRegion).toBeVisible({ timeout: 3 * 60_000 });
    const t = (await responseRegion.textContent()) || "";
    expect(t.length).toBeGreaterThan(20);
  });
});
