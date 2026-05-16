import { test, expect, testConfig } from "./fixtures";

test.describe("Sign-in flow", () => {
  test("lands on Hosted UI when unauthenticated", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(testConfig.baseUrl);
    // App boot triggers ensureSignedIn() → redirect to Hosted UI.
    await page.waitForURL(/amazoncognito\.com/, { timeout: 30_000 });
    await expect(page.locator('#signInFormUsername:visible').first()).toBeVisible();
    await expect(page.locator('#signInFormPassword:visible').first()).toBeVisible();
    await context.close();
  });

  test("signs in and lands on the SPA masthead", async ({ signedInPage }) => {
    // The fixture already drove the form; verify the post-sign-in state.
    await expect(signedInPage).toHaveURL(new RegExp(testConfig.baseUrl.replace(/^https?:\/\//, "")));
    await expect(signedInPage.locator('h1', { hasText: "Rough Cut" })).toBeVisible();
    // The masthead surfaces the signed-in email's local-part.
    const emailLocal = testConfig.userEmail.split("@")[0];
    await expect(signedInPage.locator(`text=${emailLocal}`).first()).toBeVisible();
  });

  test("status pip reads 'live' after a successful boot", async ({ signedInPage }) => {
    // The masthead shows offline / connecting / live based on the KS list call.
    await expect(signedInPage.locator("text=live").first()).toBeVisible({ timeout: 30_000 });
  });
});
