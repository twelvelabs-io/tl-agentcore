import { test, expect, selectKs } from "./fixtures";

/**
 * Phase 3 v0.4 — Rekognition + Marengo hybrid surfaces.
 *
 * Verifies that the Knowledge Graph tab renders:
 *   1. A celebrity-count delta in the counts pill (e.g. "... · N celebrities · ...")
 *   2. A "top celebrities" panel with chips for recognized faces
 *   3. The celebrity-node count in the kb_graph payload is > 0
 *
 * Pinned to ks_demo01-trailers-hollywood (the only KS with named
 * celebrities — Blender / Football / dailies KSes produce zero matches
 * from Rekognition Celebrity Detection). Overrides the default
 * TEST_KS_ID for this spec only.
 */

const TRAILERS_KS = "ks_demo01-trailers-hollywood";

test.describe("KB celebrity surface", () => {
  test("KnowledgeGraph tab shows celebrity chips + counts", async ({ signedInPage }) => {
    const kbGraphResponses: any[] = [];

    signedInPage.on("response", async (res) => {
      if (res.url().includes("/kb-graph") && res.ok()) {
        try {
          kbGraphResponses.push(await res.json());
        } catch {}
      }
    });

    await selectKs(signedInPage, TRAILERS_KS);

    const graphTab = signedInPage.locator('button.tab:has-text("Graph")').first();
    await expect(graphTab).toBeVisible({ timeout: 10_000 });
    await graphTab.click();

    // Wait for /kb-graph fetch + render. The payload + DOM both need to
    // settle before assertions; allow up to 15 s for force-graph mount.
    const chipContainer = signedInPage.getByTestId("kb-overview-celebrities");
    await expect(chipContainer).toBeVisible({ timeout: 20_000 });

    const chips = signedInPage.getByTestId("kb-celebrity-chip");
    const chipCount = await chips.count();
    console.log(`celebrity chips rendered: ${chipCount}`);
    expect(chipCount).toBeGreaterThan(0);

    // At least one chip should carry a known celebrity name surfaced by
    // Rekognition on the trailers corpus. We don't pin a specific
    // celebrity — the eval generated 17 candidates, any of them on the
    // top-25 list is enough.
    const chipTexts = (await chips.allTextContents()).map((t) => t.trim());
    console.log(`chip labels: ${JSON.stringify(chipTexts)}`);
    const expectedAny = ["Jim Carrey", "Chris Evans", "Mark Wahlberg", "Pedro Pascal", "Will Smith", "Hugh Jackman", "Emma Stone", "Ana de Armas", "Cameron Diaz", "Russell Crowe"];
    const found = expectedAny.find((name) => chipTexts.some((t) => t.includes(name)));
    expect(found, `expected one of ${expectedAny.join(" / ")} in chips`).toBeTruthy();

    // The counts pill should include the celebrity count slot.
    await expect(signedInPage.getByText(/\d+ celebrities/)).toBeVisible({ timeout: 5_000 });

    // The kb_graph payload itself should contain celebrity nodes.
    const last = kbGraphResponses[kbGraphResponses.length - 1];
    expect(last, "no /kb-graph response captured").toBeTruthy();
    expect(last.counts.celebrities ?? 0).toBeGreaterThan(0);
    expect(last.overview?.top_celebrities?.length ?? 0).toBeGreaterThan(0);
    const celebNodes = (last.nodes || []).filter((n: any) => n.kind === "celebrity");
    console.log(`payload celebrity nodes: ${celebNodes.length}`);
    expect(celebNodes.length).toBeGreaterThan(0);
  });
});
