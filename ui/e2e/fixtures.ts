// Shared Playwright fixtures for tl-agentcore E2E.
//
// signedInPage:   a Page that has already cleared the Cognito Hosted UI
//                 OAuth flow and lands on the SPA with valid tokens in
//                 localStorage. Storage state is cached to disk
//                 (e2e/storage-state.json) so subsequent tests skip the
//                 ~3-5 s sign-in dance.
//
// testConfig:     resolved test inputs (KS id, model expectations).
//                 Throws fast if a required env var is missing — better
//                 than a cryptic selector timeout halfway into a run.

import { test as base, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const STORAGE_STATE = path.resolve(__dirname, "storage-state.json");

export type TestConfig = {
  baseUrl: string;
  userEmail: string;
  userPassword: string;
  ksId: string;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`E2E env var ${name} is required (set it in ui/e2e/.env.test)`);
  return v;
}

export const testConfig: TestConfig = {
  baseUrl: process.env.E2E_BASE_URL || "https://d18q1864w6gq7b.cloudfront.net",
  userEmail: requireEnv("TEST_USER_EMAIL"),
  userPassword: requireEnv("TEST_USER_PASSWORD"),
  ksId: requireEnv("TEST_KS_ID"),
};

/** Drive the Cognito Hosted UI sign-in form once and persist tokens. */
async function signInToHostedUi(page: Page, email: string, password: string) {
  // App boot redirects to the Hosted UI. Wait for the username field.
  await page.waitForURL(/amazoncognito\.com/, { timeout: 30_000 });

  // Cognito's classic Hosted UI uses these stable input names.
  await page.locator('input[name="username"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="signInSubmitButton"], button[name="signInSubmitButton"], input[type="submit"]').first().click();

  // Cognito redirects back to the SPA with ?code=...; the SPA exchanges
  // the code for tokens and strips the query string.
  await page.waitForURL((url) => !url.toString().includes("amazoncognito.com") && !url.toString().includes("code="), {
    timeout: 60_000,
  });
}

type Fixtures = {
  signedInPage: Page;
};

export const test = base.extend<Fixtures>({
  signedInPage: async ({ browser }, use) => {
    // Reuse a cached storage state if it exists and still has valid tokens.
    let context;
    if (fs.existsSync(STORAGE_STATE)) {
      context = await browser.newContext({ storageState: STORAGE_STATE });
    } else {
      context = await browser.newContext();
    }
    const page = await context.newPage();

    await page.goto(testConfig.baseUrl);

    // If the SPA bounces us out to Cognito, drive the sign-in form. If we
    // landed straight on the SPA (cached tokens still valid), skip.
    try {
      // Race: either the masthead renders (tokens still valid), or Cognito
      // takes over (need to sign in).
      await Promise.race([
        page.waitForURL(/amazoncognito\.com/, { timeout: 8_000 }),
        page.locator('text=Rough Cut').first().waitFor({ timeout: 8_000 }),
      ]);
    } catch {
      // Timed out both — try to interpret current state below.
    }

    if (page.url().includes("amazoncognito.com")) {
      await signInToHostedUi(page, testConfig.userEmail, testConfig.userPassword);
      await context.storageState({ path: STORAGE_STATE });
    }

    // Sanity: we're back on the SPA and the masthead shows the brand.
    await expect(page.locator('h1', { hasText: "Rough Cut" })).toBeVisible({ timeout: 30_000 });

    await use(page);
    await context.close();
  },
});

export { expect };
