// Comprehensive: every brief template generates a plan that passes both
// structural checks (duration band, adjacency, asset diversity) AND a
// Bedrock-Claude reasoner quality grade.
//
// Cost note: 6 templates × (1 agent run + 1 Bedrock grading call) is
// ~$1-2 in spend per full pass. Run sparingly. The loop wrapper retries
// failures; it doesn't re-grade passes.

import { test, expect } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";
import {
  pickTemplate,
  clickAssemble,
  waitForPlan,
  readLatestPlanFromHistory,
  type CutType,
} from "./helpers/rough-cut";
import {
  assertAdjacency,
  assertAssetDiversity,
  assertDurationInBand,
  parseDurationTarget,
  sumPlanDurationSec,
} from "./helpers/plan";
import { gradeRoughCut } from "./helpers/reasoner";

type Case = {
  cutType: CutType;
  ksName: string;
  /** Cuts that don't reasonably require asset diversity (small KBs or
   *  mood reels which encourage same-mood same-asset reuse). */
  skipDiversity?: boolean;
};

const CASES: Case[] = [
  { cutType: "sizzle",     ksName: "Hollywood Trailers" },
  { cutType: "narrative",  ksName: "Hollywood Trailers" },
  { cutType: "montage",    ksName: "Hollywood Trailers" },
  { cutType: "mood",       ksName: "Hollywood Trailers", skipDiversity: true },
  { cutType: "highlight",  ksName: "Football Plays & Highlights" },
  { cutType: "rough_cut",  ksName: "Takeout" }, // short film dailies — best fit
];

test.describe("Rough Cut — every cut type, structurally + semantically valid", () => {
  for (const c of CASES) {
    test(`${c.cutType} on ${c.ksName}`, async ({ signedInPage }) => {
      await goToTab(signedInPage, "rough_cut");
      await selectKs(signedInPage, c.ksName);

      // Start a fresh cut so we don't accidentally validate a previous
      // history entry.
      const newCut = signedInPage.locator('button:has-text("+ new cut")');
      if (await newCut.isVisible().catch(() => false)) {
        await newCut.click();
      }

      await pickTemplate(signedInPage, c.cutType);
      await clickAssemble(signedInPage);
      await waitForPlan(signedInPage);

      // Read the just-saved history entry — that has the FULL plan JSON
      // exactly as the agent emitted (post-enforcer).
      const got = await readLatestPlanFromHistory(signedInPage);
      expect(got, "history must have the just-generated plan").not.toBeNull();
      const { plan, brief, ksId, ksName } = got!;

      // Brief text → duration target (e.g. "45-second sizzle reel" → 45s).
      const target = parseDurationTarget(brief);
      console.log(
        `[${c.cutType}] target=${target}s sum=${sumPlanDurationSec(plan).toFixed(1)}s scenes=${plan.scenes.length} plan.cut_type=${(plan as { cut_type?: string }).cut_type ?? "(missing)"} total_estimated=${(plan as { total_estimated_duration?: string }).total_estimated_duration ?? "?"}`,
      );

      // --- Structural assertions ---
      // 1. At least one scene with at least one primary clip.
      expect(plan.scenes.length, "scene count").toBeGreaterThanOrEqual(1);
      for (const s of plan.scenes) {
        expect(s.clips?.length, `scene "${s.scene_name ?? "?"}" needs a primary clip`).toBeGreaterThanOrEqual(1);
      }
      // 2. Adjacency: no two consecutive scenes share an asset_id.
      assertAdjacency(plan);
      // 3. Duration band: if the brief had an explicit target.
      if (target) {
        assertDurationInBand(plan, target);
      }
      // 4. Asset diversity: ≥70% distinct asset_ids across primaries.
      if (!c.skipDiversity && plan.scenes.length >= 3) {
        assertAssetDiversity(plan, 0.7);
      }

      // --- Semantic grade via Bedrock Claude ---
      const verdict = await gradeRoughCut({
        brief,
        plan,
        ks: { id: ksId, name: ksName },
        durationTargetSec: target ?? undefined,
        cutType: c.cutType,
      });
      console.log(
        `[${c.cutType}] verdict score=${verdict.score} pass=${verdict.pass} · ${verdict.rationale}`,
      );
      if (verdict.issues.length) {
        console.log(`  issues: ${verdict.issues.map((i) => `\n   - ${i}`).join("")}`);
      }
      expect(
        verdict.pass,
        `Bedrock reasoner failed the plan: ${verdict.rationale} · issues: ${verdict.issues.join(" | ")}`,
      ).toBe(true);
      expect(verdict.score, "score must be ≥6").toBeGreaterThanOrEqual(6);
    });
  }
});
