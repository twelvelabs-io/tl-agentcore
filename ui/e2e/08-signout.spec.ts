import { test, expect } from "./fixtures";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

test.describe("Sign out", () => {
  test("sign-out clears the session and bounces back to Hosted UI", async ({ signedInPage }) => {
    // The signed-in email's local-part is rendered as a clickable
    // "sign out" trigger in the masthead.
    const signOutBtn = signedInPage.locator('button:has-text("sign out")').first();
    await expect(signOutBtn).toBeVisible();
    await signOutBtn.click();

    // We land on Cognito /logout which then bounces to the SPA root.
    // The SPA, with no tokens, will redirect back to /authorize. The
    // round trip can be quick; we just need to land on amazoncognito.
    await signedInPage.waitForURL(/amazoncognito\.com/, { timeout: 30_000 });
  });

  test.afterAll(() => {
    // Clean up the cached storage state so the next test run is fresh
    // even if it ran without an explicit sign-out.
    const p = path.resolve(__dirname, "storage-state.json");
    try { fs.unlinkSync(p); } catch {}
  });
});
