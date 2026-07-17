import { test, expect } from "./fixtures";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

test.describe("Sign out", () => {
  test("sign-out clears the session and renders the SignInScreen", async ({ signedInPage }) => {
    // v0.3+: sign-out clears tokens locally + rerenders in-SPA — no
    // cross-origin bounce to Cognito /logout. The masthead's user
    // menu is a dropdown; expand it, then click "sign out".
    const userMenu = signedInPage.locator('button:has-text("▾")').first();
    await expect(userMenu).toBeVisible();
    await userMenu.click();
    const signOutBtn = signedInPage.locator('button:has-text("sign out")').first();
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();
    // Sign-in form should be back.
    await expect(signedInPage.locator('input[type="email"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(() => {
    // Clean up the cached storage state so the next test run is fresh
    // even if it ran without an explicit sign-out.
    const p = path.resolve(__dirname, "storage-state.json");
    try { fs.unlinkSync(p); } catch {}
  });
});
