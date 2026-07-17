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
    // The trigger button label is lowercase "history" in the SPA;
    // the drawer header is "§ History". Mixing the case here made
    // the click miss.
    await signedInPage.locator('button:has-text("history")').first().click();
    await expect(signedInPage.locator('text=§ History').first()).toBeVisible({ timeout: 5_000 });
    await signedInPage.waitForTimeout(400);
    await expect(signedInPage).toHaveScreenshot("history-drawer.png", {
      mask: await maskList(signedInPage),
      maxDiffPixelRatio: 0.02,
    });
  });

  test("Sign-in (in-SPA SignInScreen)", async ({ browser }) => {
    // Fresh context — no storage state. App boot renders the in-SPA
    // SignInScreen (v0.3+ replaced the Cognito Hosted UI redirect).
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(testConfig.baseUrl);
    await page.locator('input[type="email"]').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    // Baseline catches any breakage to the SignInScreen layout /
    // branding without driving a sign-in.
    await expect(page).toHaveScreenshot("signin-screen.png", {
      maxDiffPixelRatio: 0.03,
    });
    await context.close();
  });
});
