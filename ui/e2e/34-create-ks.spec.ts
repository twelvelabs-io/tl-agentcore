import { test, expect, selectKs, testConfig } from "./fixtures";

/**
 * Verifies the v0.4.4 create-knowledge-store flow. The picker (empty
 * or populated dropdown) opens an inline form that hits POST /kb/
 * knowledge-stores and auto-selects the new KS.
 *
 * We can't use the empty-fleet path here (the shared signedInPage
 * fixture requires TEST_KS_ID to already exist, which means the fleet
 * is non-empty). Instead we test the "+ New knowledge store" row
 * inside the populated dropdown, which shares the same CreateKSForm
 * component.
 *
 * Test cleans up by DELETE-ing the KS it created — the DDB row goes,
 * Rekognition collection cleanup is best-effort (won't exist for a
 * never-populated KS).
 */

test.describe("Create knowledge store", () => {
  test("+ New knowledge store adds a KS + selects it", async ({ signedInPage }) => {
    const uniqueName = `e2e-createks-${Date.now()}`;

    // Capture the create + delete API calls so we can pull the new ks_id.
    let createdKsId: string | null = null;
    signedInPage.on("response", async (res) => {
      if (res.url().endsWith("/kb/knowledge-stores") && res.request().method() === "POST" && res.ok()) {
        try {
          const body = await res.json();
          createdKsId = body._id || null;
        } catch {}
      }
    });

    // Open the KS picker dropdown.
    const picker = signedInPage.locator('button:has-text("Knowledge base")').first();
    await picker.click();

    // The dropdown's + New row lives below the existing KSes.
    const newBtn = signedInPage.locator('button:has-text("+ New knowledge store")').first();
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();

    // Fill the form + submit.
    const nameInput = signedInPage.locator('input[placeholder^="Name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill(uniqueName);
    await signedInPage.locator('input[placeholder^="Description"]').first().fill("created by 34-create-ks.spec.ts");
    await signedInPage.locator('button:has-text("create")').first().click();

    // The new KS becomes active — the picker button now shows its name.
    await expect(signedInPage.locator(`button:has-text("Knowledge base") >> text=${uniqueName}`).first())
      .toBeVisible({ timeout: 15_000 });

    // The POST returned a ks_id we can clean up with.
    await expect.poll(() => createdKsId, { timeout: 10_000 }).toBeTruthy();
    console.log(`created ks_id: ${createdKsId}`);

    // Cleanup: DELETE the KS via the same authenticated fetch the SPA uses.
    // We drive it from the page context so the Cognito access token is
    // whatever the SPA is using in this session.
    const deleteResult = await signedInPage.evaluate(async (ksId) => {
      const authHeader = (window as any).localStorage.getItem("cognito.access_token") ||
                         (window as any).localStorage.getItem("access_token");
      // Fall back to fetching the /kb list first to grab any auth wiring;
      // simplest is: rely on the same-origin cookie/token flow. The SPA
      // stores tokens in localStorage under Cognito's identityjs keys.
      // Just call the endpoint and rely on the browser's context.
      const res = await fetch(`/kb/knowledge-stores/${ksId}`, {
        method: "DELETE",
        headers: authHeader ? { authorization: `Bearer ${authHeader}` } : {},
      });
      return { status: res.status, body: await res.text().catch(() => "") };
    }, createdKsId);
    console.log(`delete cleanup: ${deleteResult.status}`);
    // Non-fatal if cleanup misfires — the row just lingers in DDB.

    // Re-select the pre-existing test KS so the next spec's signedInPage
    // fixture starts from a clean state.
    await selectKs(signedInPage, testConfig.ksId);
  });
});
