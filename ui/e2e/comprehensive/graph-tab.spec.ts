// Graph tab: loader overlay clears, search finds nodes, asset click =
// focus, second asset click = opens player.

import { test, expect } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";

test.describe("Graph tab", () => {
  test("loader overlay appears then clears, controls are visible", async ({ signedInPage }) => {
    await goToTab(signedInPage, "graph");
    await selectKs(signedInPage, "Blender Open Movies");

    // The "computing layout" / "loading thumbnails" overlay shows
    // while the sim runs + thumbs decode. It should disappear within
    // 60s for a 15-asset KB.
    await expect(signedInPage.getByText(/computing layout|loading thumbnails/i).first())
      .toBeVisible({ timeout: 5_000 })
      .catch(() => {/* may already be cleared on a fast machine */});
    await expect(signedInPage.getByText(/computing layout|loading thumbnails/i))
      .toBeHidden({ timeout: 60_000 });

    // Header chip + legend should be visible.
    await expect(signedInPage.getByText(/knowledge graph · 3D/i)).toBeVisible();
    // Search input is the floating top-right control. Real placeholder is
    // "Find a node…  ( / )".
    await expect(signedInPage.locator('input[placeholder*="Find a node"]').first())
      .toBeVisible();
  });

  test("node search finds an entity by name", async ({ signedInPage }) => {
    await goToTab(signedInPage, "graph");
    await selectKs(signedInPage, "Blender Open Movies");

    await expect(signedInPage.getByText(/computing layout|loading thumbnails/i))
      .toBeHidden({ timeout: 60_000 });

    const search = signedInPage.locator('input[placeholder*="Find a node"]').first();
    await search.click();
    await search.fill("a"); // wide query, plenty of hits
    // Candidate rows are <button> elements with class `w-full text-left`
    // — that combo appears only on the search dropdown's candidate rows
    // (the orbit / zoom controls are square buttons without w-full).
    const firstCandidate = signedInPage.locator("button.w-full.text-left").first();
    await expect(firstCandidate).toBeVisible({ timeout: 10_000 });
  });
});
