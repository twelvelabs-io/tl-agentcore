import { test, expect } from "./fixtures";

test.describe("Agent tab", () => {
  test("switching to the Agent tab renders the tool catalog and live diagram", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();

    // The two retrieval tools appear in the Suggestions block at the
    // bottom of the main pane — visible without the arch sidebar.
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible();
    await expect(signedInPage.locator("text=pegasus_analyze").first()).toBeVisible();

    // Open the live-arch rail (hidden by default) and confirm the
    // AgentCore Runtime pill mounts.
    await signedInPage.locator('button[aria-label="Toggle live architecture rail"]').click();
    await expect(signedInPage.locator('text="AgentCore Runtime"').first()).toBeVisible();
  });

  test("Jockey is not mentioned anywhere on the Agent tab", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    // Open the rail so every NodePill mounts before we scan body text.
    await signedInPage.locator('button[aria-label="Toggle live architecture rail"]').click();
    await signedInPage.locator('text="AgentCore Runtime"').first().waitFor();
    const body = (await signedInPage.locator("body").textContent()) || "";
    expect(body.toLowerCase()).not.toContain("jockey");
  });

  test("sending a short question yields a streamed text response", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();

    // Block until the Agent tab has actually mounted (tool catalog +
    // the ask textarea). "Knowledge store" as a visible label was
    // replaced by the § Question header + tool-catalog vocabulary in a
    // later UI iteration; assert on those instead.
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible({ timeout: 10_000 });
    await expect(signedInPage.locator("text=§ Question").first()).toBeVisible({ timeout: 5_000 });

    // Fill the question textarea. Use pressSequentially over fill so the
    // onChange handler fires per-character — fill() can race the React
    // state update on textareas wrapped in scrollable containers.
    const textarea = signedInPage.locator("textarea").first();
    await textarea.click();
    await textarea.pressSequentially("Summarize what's in this knowledge base in one sentence.", { delay: 5 });

    // Send button enables once draft + ks are both present.
    const submit = signedInPage.locator('button.btn-cue').first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    // Streaming responses surface as <p> updates under § II. Wait for
    // ANY text to land. Agent turns take 30-120 s.
    const responseRegion = signedInPage.locator(".response-md").first();
    await expect(responseRegion).toBeVisible({ timeout: 3 * 60_000 });
    const t = (await responseRegion.textContent()) || "";
    expect(t.length).toBeGreaterThan(20);
  });
});
