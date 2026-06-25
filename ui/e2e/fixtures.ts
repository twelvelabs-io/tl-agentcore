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
  emptyKsId: string;
  /** Per-run throwaway KS created in _global-setup.ts; used by the
   *  Library upload + mutation specs. */
  mutationsKsId: string;
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
  emptyKsId: requireEnv("TEST_EMPTY_KS_ID"),
  // Per-run throwaway KS — populated by _global-setup.ts. Module-load
  // can race that file write, so fall back to an env-var probe lazily
  // via a getter; specs that don't touch it (the majority) don't pay
  // the cost of requiring it up front.
  get mutationsKsId() { return requireEnv("TEST_MUTATIONS_KS_ID"); },
} as TestConfig;

/** Drive the Cognito Hosted UI sign-in form once and persist tokens. */
async function signInToHostedUi(page: Page, email: string, password: string) {
  // App boot redirects to the Hosted UI. Wait for the username field.
  await page.waitForURL(/amazoncognito\.com/, { timeout: 30_000 });

  // Cognito's Hosted UI renders desktop + mobile breakpoints in the same
  // DOM (two inputs with the same id, one hidden by CSS). Filter to the
  // visible one before interacting.
  await page.locator('#signInFormUsername:visible').first().fill(email);
  await page.locator('#signInFormPassword:visible').first().fill(password);
  await page.locator('input[name="signInSubmitButton"]:visible').first().click();

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

    // v0.3+ replaced the Cognito Hosted UI redirect with an in-SPA
    // SignInScreen. Three possible landing states:
    //   1. masthead already rendered (cached tokens still valid)
    //   2. inline SignInScreen rendered (need to drive the form)
    //   3. legacy redirect to amazoncognito.com (kept for back-compat)
    try {
      await Promise.race([
        page.locator('text=Rough Cut').first().waitFor({ timeout: 8_000 }),
        page.locator('input[type="email"]').first().waitFor({ timeout: 8_000 }),
        page.waitForURL(/amazoncognito\.com/, { timeout: 8_000 }),
      ]);
    } catch {
      // Timed out — fall through to the interpret-state branches below.
    }

    if (page.url().includes("amazoncognito.com")) {
      await signInToHostedUi(page, testConfig.userEmail, testConfig.userPassword);
      await context.storageState({ path: STORAGE_STATE });
    } else if (await page.locator('input[type="email"]').first().isVisible().catch(() => false)) {
      // In-SPA SignInScreen path. Fill email + password and submit.
      await page.locator('input[type="email"]').first().fill(testConfig.userEmail);
      await page.locator('input[type="password"]').first().fill(testConfig.userPassword);
      await page.locator('button[type="submit"]').first().click();
      // Wait for the masthead to settle after sign-in.
      await page.locator('text=Rough Cut').first().waitFor({ timeout: 30_000 });
      await context.storageState({ path: STORAGE_STATE });
    }

    // Sanity: we're back on the SPA and the masthead shows the brand.
    await expect(page.locator('h1', { hasText: "Rough Cut" })).toBeVisible({ timeout: 30_000 });

    // Force the active KS to the populated test fixture before each spec.
    // The SPA defaults to ksList[0], which is whichever KS the TL API
    // returns first — newest-first today, so the empty-index fixture lands
    // there and breaks every plan-generation spec. Selecting explicitly
    // makes the suite deterministic regardless of KS creation order.
    await selectKs(page, testConfig.ksId);

    await use(page);
    await context.close();
  },
});

/** Make `ksId` the active knowledge base before the spec body runs. Opens
 * the masthead picker, clicks the matching row, and waits for the dropdown
 * to fully collapse. The `▼/▲` indicator in the masthead toggles with the
 * `open` state, so we use that as the close signal — checking for the
 * dropdown rows themselves can race against React's re-render. */
export async function selectKs(page: Page, ksId: string): Promise<void> {
  const picker = page.locator('button:has-text("Knowledge base")').first();
  await expect(picker).toBeVisible({ timeout: 15_000 });
  // The masthead button shows the first 28 chars of the active id; if that
  // already matches, no UI dance is needed.
  const alreadyActive = await picker.locator(`text=${ksId.slice(0, 28)}`).count();
  if (alreadyActive === 0) {
    await picker.click();
    const option = page.locator(`button:has-text("${ksId}")`).first();
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();
  }
  // Either way, make sure the dropdown ends up CLOSED before returning so
  // subsequent locator clicks in the spec don't hit the overlay. The closed
  // state is signalled by `▼` in the masthead button.
  if ((await picker.locator("text=▲").count()) > 0) {
    await picker.click();
  }
  await expect(picker.locator("text=▼")).toBeVisible({ timeout: 5_000 });
}

export { expect };
