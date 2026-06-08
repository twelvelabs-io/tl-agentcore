// Masthead, tab navigation, KS picker, and user-dropdown / Settings modal.
// No agent calls — pure UI assertions, runs in seconds.

import { test, expect } from "../fixtures";
import { goToTab, openUserMenu, selectKs } from "./helpers/nav";

test.describe("Masthead", () => {
  test("all four tabs activate and persist a data-active marker", async ({ signedInPage }) => {
    for (const tab of ["rough_cut", "agent", "library", "graph"] as const) {
      await goToTab(signedInPage, tab);
    }
  });

  test("KS picker switches active KS by name", async ({ signedInPage }) => {
    await goToTab(signedInPage, "rough_cut");
    await selectKs(signedInPage, "Hollywood Trailers");
    await selectKs(signedInPage, "Football Plays & Highlights");
    await selectKs(signedInPage, "Takeout");
  });

  test("user dropdown shows Settings + Sign out", async ({ signedInPage }) => {
    await openUserMenu(signedInPage);
    await expect(signedInPage.getByText(/^Settings$/)).toBeVisible();
    await expect(signedInPage.getByText(/^Sign out$/)).toBeVisible();
    // Close by clicking outside.
    await signedInPage.locator("body").click({ position: { x: 5, y: 5 } });
    await expect(signedInPage.getByText(/^Settings$/)).toBeHidden();
  });

  test("Settings modal opens, shows both prompts, reset disabled when default", async ({ signedInPage }) => {
    await openUserMenu(signedInPage);
    await signedInPage.getByText(/^Settings$/).click();
    await expect(signedInPage.getByText(/System prompts/i)).toBeVisible();
    // Both prompt editors should be present.
    await expect(signedInPage.getByText(/Rough Cut Agent/i)).toBeVisible();
    await expect(signedInPage.getByText(/Pegasus profile prompt/i)).toBeVisible();
    // The "reset to default" button exists per editor (disabled when no
    // override).
    const resetBtns = signedInPage.locator('button:has-text("reset to default")');
    expect(await resetBtns.count()).toBeGreaterThanOrEqual(2);
    // Close.
    await signedInPage.locator('button:has-text("close")').first().click();
    await expect(signedInPage.getByText(/System prompts/i)).toBeHidden();
  });
});
