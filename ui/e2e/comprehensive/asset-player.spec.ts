// GlobalAssetPlayer modal: open from library, close behaviors.

import { test, expect, type Page } from "@playwright/test";
import { test as base } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";

// Wait for the player modal to fully unmount. Framer Motion's exit
// animation keeps the backdrop in the DOM for ~200ms after onClose; the
// next card-click would otherwise be intercepted by the disappearing
// `.fixed.inset-0.z-50` backdrop.
async function waitModalGone(page: Page) {
  await expect(page.locator("div.fixed.inset-0.z-50")).toHaveCount(0, { timeout: 5_000 });
}

base("opens from library and closes (backdrop + close-button)", async ({ signedInPage }) => {
  await goToTab(signedInPage, "library");
  await selectKs(signedInPage, "Blender Open Movies");

  const firstCard = signedInPage.locator("button.clip-card").first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });

  // Library uses double-click semantics: first click selects, second opens
  // the player. See ui/src/components/Library.tsx (ItemCard onClick).
  await firstCard.click();
  await firstCard.click();
  await expect(signedInPage.locator("video").first()).toBeVisible({ timeout: 15_000 });

  // Close 1: click the backdrop. Outer motion.div has onClick={onClose}.
  await signedInPage
    .locator("div.fixed.inset-0.z-50")
    .first()
    .click({ position: { x: 20, y: 20 }, force: true });
  await waitModalGone(signedInPage);

  // Re-open. The card is STILL selected from the first round (Library's
  // selectedId state isn't cleared by closing the modal), so one click is
  // enough this time — double-click would re-fire onClick a second time
  // which can race with the AnimatePresence backdrop and close the modal.
  await firstCard.click();
  await expect(signedInPage.locator("video").first()).toBeVisible({ timeout: 15_000 });
  await signedInPage
    .locator('button:has-text("close ✕")')
    .first()
    .evaluate((el) => (el as HTMLButtonElement).click());
  await waitModalGone(signedInPage);
});
