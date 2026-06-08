// Rough-cut workflow helpers: pick template, fill brief, generate, wait
// for plan, read plan back from localStorage history.

import { expect, type Page } from "@playwright/test";

export type CutType = "sizzle" | "narrative" | "montage" | "mood" | "highlight" | "rough_cut";

const TEMPLATE_LABEL: Record<CutType, string> = {
  sizzle:     "Sizzle reel",
  narrative:  "Narrative trailer",
  montage:    "Montage",
  mood:       "Mood reel / B-roll",
  highlight:  "Highlight reel",
  rough_cut:  "Rough cut · doc/film",
};

/** Click a brief-template chip and confirm the textarea has the canned text. */
export async function pickTemplate(page: Page, type: CutType) {
  await page.locator(`button:has-text("${TEMPLATE_LABEL[type]}")`).first().click();
  const ta = page.locator("textarea").first();
  // The canned text is several hundred chars; just confirm non-empty.
  await expect(async () => {
    const v = await ta.inputValue();
    expect(v.length).toBeGreaterThan(80);
  }).toPass({ timeout: 5_000 });
}

export async function setBrief(page: Page, text: string) {
  const ta = page.locator("textarea").first();
  await ta.fill(text);
}

export async function clickAssemble(page: Page) {
  await page.locator('button:has-text("assemble rough cut")').click();
}

/** Wait until the plan renders. Conservative timeout — agent + Marengo +
 *  duration-enforcer post-processing can take 60-180s on real KBs. */
export async function waitForPlan(page: Page, timeoutMs = 4 * 60_000) {
  // Plan renders the timeline header with "<N> scenes · <M> clips".
  await expect(page.getByText(/\d+ scenes? · \d+ clips?/).first())
    .toBeVisible({ timeout: timeoutMs });
}

/** Read the most-recent rough-cut history entry the UI persisted to
 *  localStorage. Returns null if the suite is running pre-plan or storage
 *  was cleared. */
export async function readLatestPlanFromHistory(page: Page) {
  return await page.evaluate(() => {
    // History key — must match `KEY` in ui/src/lib/roughcut-history.ts.
    const raw = localStorage.getItem("tl-agentcore.roughcut.history.v1");
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      for (const e of arr) {
        if (e?.kind === "rough_cut" && e?.plan?.scenes?.length) {
          return { entry: e, plan: e.plan, brief: e.script, ksId: e.ks_id, ksName: e.ks_name };
        }
      }
    } catch {}
    return null;
  });
}
