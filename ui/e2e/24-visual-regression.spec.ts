import { test, expect, testConfig, selectKs } from "./fixtures";

/** Visual-regression baselines for the five key views the SPA exposes.
 *  Re-baseline with `npx playwright test e2e/24-visual-regression.spec.ts
 *  --update-snapshots` when an intentional layout change lands. The
 *  goal isn't pixel-perfect parity — it's catching unintentional drift
 *  (a button that lost its border, a tab that shifted, a color token
 *  that flipped on a theme update).
 *
 *  We mask elements that are inherently non-deterministic so the diff
 *  stays signal-rich:
 *    - the masthead status pip (animates)
 *    - the KS picker label (shows the active KS id)
 *    - the LiveArchDiagram canvas (data-points jitter on re-render)
 *    - any clip thumbnails in the library grid */
const MASKS = [
  '[data-testid="status-pip"]',
  'button:has-text("Knowledge base")',
  '.live-arch',
  '.clip-card img',
];

async function maskList(page: any) {
  return MASKS.map((sel) => page.locator(sel));
}

test.describe("Visual regression: layout baselines", () => {
  test("RoughCut tab empty state", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await expect(signedInPage.locator('text=§ Brief')).toBeVisible({ timeout: 10_000 });
    await signedInPage.waitForTimeout(500);
    await expect(signedInPage).toHaveScreenshot("rough-cut-empty.png", {
      mask: await maskList(signedInPage),
      maxDiffPixelRatio: 0.02,
    });
  });

  test("Agent tab empty state", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator('text=§ Question').first()).toBeVisible({ timeout: 10_000 });
    await signedInPage.waitForTimeout(500);
    await expect(signedInPage).toHaveScreenshot("agent-empty.png", {
      mask: await maskList(signedInPage),
      maxDiffPixelRatio: 0.02,
    });
  });

  test("Library tab populated state", async ({ signedInPage }) => {
    await selectKs(signedInPage, testConfig.ksId);
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });
    // Let the grid fully render before snapshotting.
    await signedInPage.waitForTimeout(800);
    await expect(signedInPage).toHaveScreenshot("library-populated.png", {
      mask: await maskList(signedInPage),
      maxDiffPixelRatio: 0.03,
    });
  });

  test("History drawer open", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Rough Cut")').first().click();
    await signedInPage.locator('button:has-text("History")').first().click();
    await expect(signedInPage.locator('text=§ History').first()).toBeVisible({ timeout: 5_000 });
    await signedInPage.waitForTimeout(400);
    await expect(signedInPage).toHaveScreenshot("history-drawer.png", {
      mask: await maskList(signedInPage),
      maxDiffPixelRatio: 0.02,
    });
  });

  test("Sign-in (Cognito Hosted UI)", async ({ browser }) => {
    // Fresh context — no storage state. App boot redirects to Hosted UI.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(testConfig.baseUrl);
    await page.waitForURL(/amazoncognito\.com/, { timeout: 30_000 });
    await page.locator('#signInFormUsername:visible').first().waitFor();
    await page.waitForTimeout(500);
    // Cognito Hosted UI loads custom CSS; baseline catches any breakage
    // in our login-screen branding without driving a sign-in.
    await expect(page).toHaveScreenshot("signin-hosted-ui.png", {
      maxDiffPixelRatio: 0.03,
    });
    await context.close();
  });
});
