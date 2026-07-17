import { test, expect, testConfig } from "./fixtures";

test.describe("Sign-in flow", () => {
  test("renders the in-SPA SignInScreen when unauthenticated", async ({ browser }) => {
    // v0.3 replaced the Cognito Hosted UI redirect with an in-SPA
    // SignInScreen. An unauthenticated boot now shows the form
    // inline; no cross-origin bounce to amazoncognito.com.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(testConfig.baseUrl);
    await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('button[type="submit"]').first()).toBeVisible();
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
