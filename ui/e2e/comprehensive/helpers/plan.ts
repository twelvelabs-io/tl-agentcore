// Plan structural helpers — used by every rough-cut spec to assert the
// fields that don't need the reasoner. Cheap, deterministic, fast.

import { expect, type Page } from "@playwright/test";

export type ClipShape = {
  video_reference: string;
  start_time: string;
  end_time: string;
  rank?: number;
  role?: string;
  take_note?: string;
  alternatives?: Array<{ video_reference: string; start_time: string; end_time: string; rank?: number }>;
};
export type SceneShape = {
  scene_id?: string;
  scene_name?: string;
  narrative_purpose?: string;
  clips: ClipShape[];
};
export type PlanShape = {
  title?: string;
  cut_type?: string;
  scenes: SceneShape[];
  total_estimated_duration?: string;
  notes?: string;
};

export function parseTime(t: string | undefined): number {
  if (!t) return 0;
  const parts = t.split(":").map((s) => parseFloat(s));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

export function sumPlanDurationSec(plan: PlanShape): number {
  return plan.scenes.reduce((s, sc) => {
    const c = sc.clips?.[0];
    if (!c) return s;
    return s + Math.max(parseTime(c.end_time) - parseTime(c.start_time), 0);
  }, 0);
}

/** Parse an unambiguous duration TARGET out of the brief. Returns seconds
 *  or null. Avoids matching per-clip duration phrasing like "2-4 second
 *  clips" or "5-15 s each" — those describe SCENE durations, not the
 *  TOTAL cut length. We deliberately accept only:
 *    - "Target N seconds" / "Target N minutes"
 *    - "Aim for N seconds" / "Aim for N minutes"
 *    - "<N>-second" / "<N>-minute" followed by a noun like reel/cut/sizzle/...
 *    - "<N> sec[ond]s" / "<N> min[ute]s" near beginning of brief (first
 *      occurrence wins).
 *  Range patterns (e.g. "2-4 second clips") are explicitly rejected. */
export function parseDurationTarget(brief: string): number | null {
  const text = brief.replace(/\s+/g, " ");

  // 1. Explicit "Target N <unit>" / "Aim for N <unit>".
  const explicit = /\b(?:target|aim(?:\s+for)?)\s+~?(\d+(?:\.\d+)?)\s*(minute[s]?|min(?:s)?|second[s]?|sec(?:onds)?|s)\b/i.exec(text);
  if (explicit) {
    const n = parseFloat(explicit[1]);
    return /^m/i.test(explicit[2]) ? n * 60 : n;
  }

  // 2. Hyphenated "<N>-second" / "<N>-minute" — typical phrasing for the
  //    cut's total target ("Build me a 45-second sizzle reel", "Cut me a
  //    90-second narrative trailer"). Requires a HYPHEN to avoid matching
  //    "2 to 4 second clips" (no hyphen between number and unit there).
  const hyphenated = /\b(\d+(?:\.\d+)?)[-–](second|sec|minute|min)s?\b/i.exec(text);
  if (hyphenated) {
    const n = parseFloat(hyphenated[1]);
    return /^m/i.test(hyphenated[2]) ? n * 60 : n;
  }

  // 3. Plain "<N> minutes total" / "<N> seconds total".
  const totalised = /\b(\d+(?:\.\d+)?)\s*(minute[s]?|min(?:s)?|second[s]?|sec(?:onds)?)\s+total\b/i.exec(text);
  if (totalised) {
    const n = parseFloat(totalised[1]);
    return /^m/i.test(totalised[2]) ? n * 60 : n;
  }

  // No unambiguous target found — let the caller decide whether to assert.
  return null;
}

/** Pull the plan JSON out of the page's React state by reading the rendered
 *  scene cards' data + reconstructing. The plan isn't exposed in window so we
 *  scrape what's visible — sufficient for structural checks. */
export async function scrapePlanFromUI(page: Page): Promise<PlanShape> {
  // Title
  const title = (await page.locator("section h1, section h2, p.font-display").first().textContent({ timeout: 5_000 })) || "";

  // Scene cards — each has a header "scene NN" + name, then a clip block
  // with "<asset_filename or asset_id> · role" + start/end timecodes.
  const scenes: SceneShape[] = await page.evaluate(() => {
    const out: any[] = [];
    const sceneHeaders = Array.from(document.querySelectorAll("ol > li, [data-scene]"));
    for (const el of sceneHeaders) {
      // Each scene li renders: scene NN, name, narrative_purpose, then clips.
      const txt = el.textContent || "";
      // Match the first clip block's timecodes from the mono "HH:MM:SS" pairs.
      const tcMatches = txt.match(/\d{2}:\d{2}:\d{2}/g) || [];
      if (tcMatches.length < 2) continue;
      // Asset id: 24-hex string OR filename (".mp4")
      const idMatch = txt.match(/[a-f0-9]{24}/);
      const fileMatch = txt.match(/[\w.-]+\.mp4/i);
      const sceneNameMatch = txt.match(/scene\s+\d+\s*([\s\S]*?)(?:Cold\s|Setup|Conflict|Resolution|\d{2}:|$)/i);
      out.push({
        scene_name: sceneNameMatch?.[1]?.trim()?.split("\n")?.[0] || "",
        clips: [
          {
            video_reference: idMatch?.[0] || fileMatch?.[0] || "",
            start_time: tcMatches[0],
            end_time: tcMatches[1],
            role: undefined,
          },
        ],
      });
    }
    return out;
  });

  return { title: title.trim(), scenes };
}

/** A more reliable path: read the plan from the actual <plan>…</plan> JSON
 *  the agent emitted, captured from the chat thread's data-attribute or via
 *  the localStorage history entry the UI writes after each cut. */
export async function readPlanFromLocalStorageHistory(page: Page): Promise<PlanShape | null> {
  return await page.evaluate(() => {
    const raw = localStorage.getItem("tl-agentcore.roughcut.history.v1");
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      // Latest entry of kind=rough_cut with a non-empty plan.
      for (const e of arr) {
        if (e?.kind === "rough_cut" && e?.plan?.scenes?.length) {
          return e.plan;
        }
      }
    } catch {}
    return null;
  });
}

/** Adjacency check: no two consecutive scene primaries share an asset_id. */
export function assertAdjacency(plan: PlanShape) {
  const primaries = plan.scenes.map((s) => s.clips?.[0]?.video_reference || "");
  for (let i = 1; i < primaries.length; i++) {
    expect(
      primaries[i],
      `adjacency violation: scene ${i} and ${i + 1} share asset_id ${primaries[i]}`,
    ).not.toBe(primaries[i - 1]);
  }
}

/** Duration-band check vs an explicit target. ±max(3s, 10% of target). */
export function assertDurationInBand(plan: PlanShape, targetSec: number) {
  const sum = sumPlanDurationSec(plan);
  const band = Math.max(3, 0.1 * targetSec);
  expect(
    Math.abs(sum - targetSec),
    `duration: sum=${sum.toFixed(1)}s vs target=${targetSec}s · band=±${band.toFixed(1)}s`,
  ).toBeLessThanOrEqual(band);
}

/** Asset-diversity check for sizzle/narrative/montage/highlight/rough_cut. */
export function assertAssetDiversity(plan: PlanShape, minDistinctRatio = 0.7) {
  const ids = plan.scenes.map((s) => s.clips?.[0]?.video_reference || "").filter(Boolean);
  const distinct = new Set(ids).size;
  const required = Math.ceil(ids.length * minDistinctRatio);
  expect(
    distinct,
    `asset diversity: ${distinct} distinct of ${ids.length} (need ≥${required})`,
  ).toBeGreaterThanOrEqual(required);
}
