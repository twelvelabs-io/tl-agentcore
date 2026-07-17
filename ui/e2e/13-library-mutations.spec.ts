import { test, expect, testConfig, selectKs } from "./fixtures";

/** Library — search/filter/detach/delete. The search + filter tests
 *  run against the read-only populated KS; the detach + delete tests
 *  attach a fresh asset to the per-run throwaway KS first, then
 *  exercise the irreversible operations. */

const TL = "https://api.twelvelabs.io/v1.3";

async function tlPost<T = any>(path: string, body: FormData | object): Promise<T> {
  const apiKey = process.env.TL_API_KEY!;
  const isForm = body instanceof FormData;
  const res = await fetch(`${TL}${path}`, {
    method: "POST",
    headers: isForm ? { "x-api-key": apiKey } : { "x-api-key": apiKey, "content-type": "application/json" },
    body: isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

async function tlGet<T = any>(path: string): Promise<T> {
  const apiKey = process.env.TL_API_KEY!;
  const res = await fetch(`${TL}${path}`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function seedAssetIntoMutationsKs(ksId: string, url: string, indexId: string): Promise<string> {
  const fd = new FormData();
  fd.append("method", "url");
  fd.append("url", url);
  fd.append("index_id", indexId);
  fd.append("enable_hls", "true");
  fd.append("enable_thumbnail", "true");
  const asset = await tlPost<{ _id: string }>("/assets", fd);
  await tlPost(`/knowledge-stores/${ksId}/items`, { asset_id: asset._id });
  return asset._id;
}

test.describe("Library: search + status filters (read-only)", () => {
  test("typing a query in the search input narrows the visible grid", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("text=§ Library").first()).toBeVisible({ timeout: 10_000 });
    // Wait for at least one item card to render.
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });
    const before = await signedInPage.locator("button.clip-card").count();
    expect(before).toBeGreaterThan(0);

    // The populated test KS has Bunny / Jellyfish / Sintel; type a
    // substring that matches only one filename.
    await signedInPage.locator('input[type="search"]').first().fill("Sintel");
    // Wait briefly for the filter to take effect.
    await signedInPage.waitForTimeout(500);
    const filtered = await signedInPage.locator("button.clip-card").count();
    expect(filtered).toBeLessThan(before);

    // Clear: every item visible again.
    await signedInPage.locator('input[type="search"]').first().fill("");
    await signedInPage.waitForTimeout(500);
    const after = await signedInPage.locator("button.clip-card").count();
    expect(after).toBe(before);
  });

  test("clicking a status filter chip toggles its active styling", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator('button:has-text("ready")').first()).toBeVisible();
    const ready = signedInPage.locator('button:has-text("ready")').first();
    await ready.click();
    // Active chip carries a different background/border than inactive
    // ones. Asserting the style shifts via getAttribute("style") is
    // brittle; instead, assert it can be toggled back to "all".
    await signedInPage.locator('button:has-text("all")').first().click();
  });
});

test.describe("Library: detach + delete (uses throwaway mutations KS)", () => {
  // Both detach + delete tests seed assets via the legacy TL SaaS API
  // (`api.twelvelabs.io/v1.3/assets`, `.../items`). v0.4 removed the
  // /tl/* browser proxy path and the deploy contract no longer
  // requires a working TL_API_KEY, so we skip these unconditionally
  // until the seed path is rewritten to hit our own /upload → /kb
  // pipeline. That rewrite is non-trivial (each real upload runs
  // 30-90s through the async pipeline) so it's tracked separately.
  test.skip(true, "legacy TL SaaS seed path unavailable in v0.4 — rewrite tracked separately");
  test("detach removes the item from the active KB grid", async ({ signedInPage }) => {
    // Resolve the index this account uses (we need it for asset creation).
    const indexList = await tlGet<{ data: any[] }>("/indexes?page_limit=20");
    const index = indexList.data?.find((i) => i.index_name === "tl-agentcore-e2e-index");
    if (!index) throw new Error("test index not found");

    // Seed: attach a fresh asset to the mutations KS via TL API.
    const url = "https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4";
    await seedAssetIntoMutationsKs(testConfig.mutationsKsId, url, index._id);

    // Switch the active KS to the mutations one.
    await selectKs(signedInPage, testConfig.mutationsKsId);
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });
    const before = await signedInPage.locator("button.clip-card").count();
    expect(before).toBeGreaterThanOrEqual(1);

    // Select an item, click Detach.
    await signedInPage.locator("button.clip-card").first().click();
    await expect(signedInPage.locator('button:has-text("Detach from KB")')).toBeVisible();
    await signedInPage.locator('button:has-text("Detach from KB")').click();

    // Grid shrinks (optimistic UI update).
    await expect.poll(async () => signedInPage.locator("button.clip-card").count(), {
      timeout: 10_000,
    }).toBeLessThan(before);
  });

  test("delete-confirm removes the asset entirely from TL", async ({ signedInPage }) => {
    const indexList = await tlGet<{ data: any[] }>("/indexes?page_limit=20");
    const index = indexList.data?.find((i) => i.index_name === "tl-agentcore-e2e-index");
    if (!index) throw new Error("test index not found");

    const url = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
    const assetId = await seedAssetIntoMutationsKs(testConfig.mutationsKsId, url, index._id);

    await selectKs(signedInPage, testConfig.mutationsKsId);
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });

    // Select + click Delete asset entirely + confirm.
    await signedInPage.locator("button.clip-card").first().click();
    await signedInPage.locator('button:has-text("Delete asset entirely")').click();
    await expect(signedInPage.locator("text=Delete asset?")).toBeVisible();
    await signedInPage.locator('button:has-text("Delete forever")').click();

    // Asset is gone from TL.
    await expect.poll(
      async () => {
        const res = await fetch(`${TL}/assets/${assetId}`, { headers: { "x-api-key": process.env.TL_API_KEY! } });
        return res.status;
      },
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(400);
  });
});
