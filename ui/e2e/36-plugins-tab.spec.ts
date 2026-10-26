// Data sources tab (plugin surface for Distribution-Readiness).
//
// Smoke-test: open Settings → Data sources, verify the tab mounts and
// hits /plugins without erroring. No CRUD here — creating a plugin
// requires a valid Lambda ARN that passes AgentCore Gateway's inline
// schema validation, which is PR 2 content. For PR 1 we just prove
// the UI → CloudFront → HTTP API → lambda → DynamoDB path is wired.
import { test, expect } from "./fixtures";

test.describe("Data sources tab", () => {
  test("Settings → Data sources tab mounts and lists without error", async ({ signedInPage }) => {
    const userMenu = signedInPage.locator('button[title^="signed in as"]').first();
    await expect(userMenu).toBeVisible({ timeout: 10_000 });
    await userMenu.click();

    await signedInPage.locator('button:has-text("Settings")').first().click();

    // Modal lands on Prompts; click Data sources.
    await expect(signedInPage.locator('h2:has-text("System prompts")').first()).toBeVisible({ timeout: 10_000 });
    await signedInPage.locator('button:has-text("Data sources")').first().click();

    // Header flips to "Data sources".
    await expect(signedInPage.locator('h2:has-text("Data sources")').first()).toBeVisible({ timeout: 5_000 });

    // Three terminal states — settle on any within 15s:
    //   - "No customer plugins yet." (empty DDB)
    //   - row with a plugin "name" header   (populated)
    //   - any error toast                   (fails the test, caught below)
    await expect(
      signedInPage.locator("text=/No customer plugins yet\\.|customer-added|plugin_echo/").first(),
    ).toBeVisible({ timeout: 15_000 });

    // Regression guard: a lambda/CloudFront/IAM break shows the inline
    // red error banner at the top of the tab, not one of the healthy
    // states.
    const errCount = await signedInPage.locator('div:has-text("plugins ")').filter({ hasText: /^plugins \d{3}:/ }).count();
    expect(errCount).toBe(0);
  });
});
