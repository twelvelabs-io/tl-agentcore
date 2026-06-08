// UI navigation helpers shared across comprehensive specs.

import { expect, type Page } from "@playwright/test";

export type TabId = "rough_cut" | "agent" | "library" | "graph";

const TAB_LABELS: Record<TabId, string> = {
  rough_cut: "Rough Cut",
  agent: "Agent",
  library: "Library",
  graph: "Graph",
};

export async function goToTab(page: Page, tab: TabId) {
  await page.locator(`button:has-text("${TAB_LABELS[tab]}")`).first().click();
  // Tab buttons set data-active=true on the chosen one.
  await expect(page.locator(`button[data-active="true"]:has-text("${TAB_LABELS[tab]}")`)).toBeVisible();
}

/** Pick a KS by visible name fragment. Idempotent if it's already active. */
export async function selectKs(page: Page, nameFragment: string) {
  // KS picker is a button on the masthead that opens a dropdown. The label
  // includes ▾.
  const trigger = page.locator('button:has-text("Knowledge base")').first();
  // If the trigger isn't visible, the picker may already be open OR the
  // chrome moved — fall back to clicking the visible KS name button.
  try {
    await trigger.click({ timeout: 5_000 });
  } catch {
    await page.locator('button:has-text("▾"), [aria-haspopup="listbox"]').first().click();
  }
  await page.getByText(nameFragment, { exact: false }).first().click();
  await expect(page.locator(`text=${nameFragment}`).first()).toBeVisible();
}

/** Open the user dropdown menu (top-right of the masthead). */
export async function openUserMenu(page: Page) {
  // The trigger shows "<handle> ▾".
  await page.locator('button:has-text("▾")').last().click();
  await expect(page.getByRole("button", { name: /settings/i }).or(page.getByText(/settings/i))).toBeVisible();
}
