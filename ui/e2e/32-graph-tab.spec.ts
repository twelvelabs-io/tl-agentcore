import { test, expect, testConfig, selectKs } from "./fixtures";

/** Phase 4 UI — diagnoses the 3D knowledge-graph tab.
 *
 * Logs every console message + every kb-graph network event so when the
 * tab silently fails we can see why (auth, CORS, JS errors, three.js init).
 */

test.describe("Graph tab (3D)", () => {
  test("loads, hits /kb-graph, renders a canvas", async ({ signedInPage }) => {
    const consoleLines: string[] = [];
    const requestLog: string[] = [];

    signedInPage.on("console", (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    signedInPage.on("pageerror", (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });
    signedInPage.on("request", (req) => {
      if (req.url().includes("/kb-graph") || req.url().includes("/tl/assets")) {
        requestLog.push(`→ ${req.method()} ${req.url()}`);
      }
    });
    signedInPage.on("response", async (res) => {
      if (res.url().includes("/kb-graph")) {
        const body = await res.text().catch(() => "(unreadable)");
        requestLog.push(`← ${res.status()} ${res.url()} :: ${body.slice(0, 240)}`);
      }
    });

    await selectKs(signedInPage, testConfig.ksId);

    // The Graph tab should be in the masthead at numeral IV.
    const graphTab = signedInPage.locator('button.tab:has-text("Graph")').first();
    await expect(graphTab).toBeVisible({ timeout: 10_000 });
    await graphTab.click();

    // Wait briefly for the fetch + canvas mount.
    await signedInPage.waitForTimeout(8_000);

    // Dump diagnostic info regardless of pass/fail so we can see what blew up.
    console.log("\n── CONSOLE ──");
    for (const line of consoleLines) console.log(line);
    console.log("\n── NETWORK (kb-graph + tl/assets) ──");
    for (const line of requestLog) console.log(line);

    // Three.js renders into a <canvas>. If it's there, the graph mounted.
    const canvasCount = await signedInPage.locator("canvas").count();
    console.log(`\n── DOM ── canvas elements: ${canvasCount}`);

    // Also probe the top-left chip we add in GraphInner.
    const chip = signedInPage.locator('text=knowledge graph · 3D · live').first();
    const chipVisible = await chip.isVisible().catch(() => false);
    console.log(`graph chip visible: ${chipVisible}`);

    // Soft expectations — we want diagnostics, not a hard pass/fail at first.
    expect(canvasCount, "3D graph should mount a canvas").toBeGreaterThan(0);

    // Hard expectation: NO pageerror exceptions logged.
    const pageErrors = consoleLines.filter((l) => l.startsWith("[pageerror]"));
    expect(pageErrors, `pageerror should be empty\n${pageErrors.join("\n")}`).toHaveLength(0);

    // Screenshot to disk so the operator can visually confirm.
    await signedInPage.screenshot({ path: "test-results/32-graph-tab.png", fullPage: false });
  });
});
