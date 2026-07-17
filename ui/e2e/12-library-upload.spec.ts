import { test, expect } from "./fixtures";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Library — file-upload happy path. Drives the hidden <input type="file">
 *  with a freshly-generated tiny mp4, watches the UploadRow status
 *  transition through the full pipeline (presign → S3 PUT → asset create →
 *  KB attach → embed kickoff → done), and asserts the new item shows up in
 *  the grid.
 *
 *  Runs against the per-run throwaway KS so we never pollute a real KB.
 *  The KS is dropped wholesale in _global-teardown.ts; we don't need to
 *  detach/delete here. */

const FIXTURE_DIR = path.resolve(os.tmpdir(), "tl-agentcore-e2e-fixtures");
const FIXTURE_MP4 = path.join(FIXTURE_DIR, "tiny.mp4");

function ensureFixtureMp4(): string {
  if (fs.existsSync(FIXTURE_MP4)) return FIXTURE_MP4;
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  // 5-second colored test pattern with a quiet sine tone, encoded as a
  // small mp4 (~200 KB) that TL accepts as a valid video asset. TL
  // requires resolution >= 360x360 and duration >= 4 s; the tone gives
  // Marengo something to embed in the audio modality.
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=5:size=480x360:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
    "-c:a", "aac", "-b:a", "32k",
    FIXTURE_MP4,
  ]);
  return FIXTURE_MP4;
}

test.describe("Library: upload happy path", () => {
  test("dropping a file streams through presign → S3 → asset → attach → done", async ({ signedInPage }) => {
    const mp4 = ensureFixtureMp4();

    // Create a per-test scratch KS via the same POST /kb/knowledge-stores
    // path the SPA uses, then activate it via LS_LAST_KS_ID + reload.
    // globalSetup's TL-SaaS-backed mutations KS is gated on TL_API_KEY
    // and can leave a stale id in .env.test — driving the scratch KS
    // from inside the spec makes this test self-sufficient.
    const uniqueName = `e2e-upload-${Date.now()}`;
    const ks = await signedInPage.evaluate(async (name: string) => {
      let token: string | null = null;
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.endsWith(".accessToken")) { token = localStorage.getItem(k); break; }
      }
      const res = await fetch("/kb/knowledge-stores", {
        method: "POST",
        headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name, description: "e2e upload happy-path" }),
      });
      if (!res.ok) throw new Error(`create failed: ${res.status}`);
      return res.json();
    }, uniqueName);
    await signedInPage.evaluate((id: string) => {
      localStorage.setItem("tl-agentcore.lastKsId", id);
    }, ks._id);
    await signedInPage.reload();
    await expect(signedInPage.locator(`button:has-text("Knowledge base") >> text=${uniqueName}`).first())
      .toBeVisible({ timeout: 15_000 });

    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator("text=§ Library").first()).toBeVisible({ timeout: 10_000 });

    // The KS starts empty (globalSetup creates fresh, no items).
    const startCount = await signedInPage.locator("button.clip-card").count();
    expect(startCount).toBe(0);

    // Drive the hidden <input type="file">. The DropZone is purely a
    // click-passthrough to this input; setInputFiles fires the same
    // change-handler.
    await signedInPage.locator('input[type="file"]').setInputFiles(mp4);

    // The upload row appears in the left rail. Status text cycles
    // through `signing url` → `uploading` → `creating asset` →
    // `attaching` → `embedding` → `added · indexing in background`.
    // We anchor on `uploading` (proves presign + S3 PUT started) and
    // the final `added · indexing in background` label (proves asset
    // create + KS attach + embed kickoff all succeeded).
    await expect(signedInPage.locator('text=§ Uploads')).toBeVisible({ timeout: 5_000 });
    await expect(signedInPage.locator('text=uploading').first()).toBeVisible({ timeout: 30_000 });
    // Asset-create + KS-attach + embed-kickoff combined can take a
    // while on a cold lambda; give it a wide window.
    await expect(
      signedInPage.locator('text=added · indexing in background').first(),
    ).toBeVisible({ timeout: 120_000 });

    // The grid auto-refreshes after upload completes via listItems(ksId).
    // TL has brief read-after-write lag on the items list; poll wide.
    await expect.poll(
      async () => signedInPage.locator("button.clip-card").count(),
      { timeout: 60_000, intervals: [2_000] },
    ).toBeGreaterThanOrEqual(1);
  });
});
