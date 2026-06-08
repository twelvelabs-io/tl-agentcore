import { test, expect, testConfig } from "./fixtures";

test.describe("Library tab", () => {
  test("§ III · Library renders against the active KB", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator('text=§ Library').first()).toBeVisible({ timeout: 10_000 });

    // The center pane shows an upload drop zone.
    await expect(signedInPage.locator('text=Drop a video here')).toBeVisible();

    // At least one item card eventually renders (signedInPage selects the
    // populated test KS so /tl/knowledge-stores/{ks}/items returns rows).
    const card = signedInPage.locator('button.clip-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
  });

  test("clicking an item opens the details rail with detach + delete actions", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    const card = signedInPage.locator('button.clip-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    await expect(signedInPage.locator('text=§ Item details').first()).toBeVisible();
    await expect(signedInPage.locator('button:has-text("Detach from KB")')).toBeVisible();
    await expect(signedInPage.locator('button:has-text("Delete asset entirely")')).toBeVisible();
  });

  test("delete confirm modal opens but cancel keeps the asset", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    const card = signedInPage.locator('button.clip-card').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    await signedInPage.locator('button:has-text("Delete asset entirely")').click();
    await expect(signedInPage.locator('text=Delete asset?')).toBeVisible();
    await signedInPage.locator('button:has-text("Cancel")').click();
    await expect(signedInPage.locator('text=Delete asset?')).toBeHidden();
    // Ensure the item is still present in the list.
    await expect(signedInPage.locator('button.clip-card').first()).toBeVisible();
    void testConfig; // keep the import shape consistent with neighboring specs
  });
});
