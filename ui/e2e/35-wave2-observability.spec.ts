// Wave-2 observability surfaces: activity strip, judge panel, Usage tab.
//
// These three features all shipped unconditionally in PR #45 / #48. If
// any of them regresses, the UI will silently hide what the runtime is
// doing — making it look like preseed / ReWOO / judges aren't running
// when they still are. Covering them here catches a frontend-side
// regression even when the runtime stays healthy.
import { test, expect } from "./fixtures";

test.describe("Wave-2 observability", () => {
  test("Agent turn renders § Trace activity strip + § Judges panel", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();

    // Block until the Agent tab is actually mounted.
    await expect(signedInPage.locator("text=vector_search").first()).toBeVisible({ timeout: 10_000 });
    await expect(signedInPage.locator("text=§ Question").first()).toBeVisible({ timeout: 5_000 });

    const textarea = signedInPage.locator("textarea").first();
    await textarea.click();
    await textarea.pressSequentially(
      "Summarize what's in this knowledge base in one sentence.",
      { delay: 5 },
    );

    const submit = signedInPage.locator("button.btn-cue").first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    // Wait for the streamed response to accumulate (same guard as
    // 07-agent-tab's streaming test — the response region flips visible
    // on the first token but the trace strip doesn't materialize until
    // at least one activity frame has landed).
    const responseRegion = signedInPage.locator(".response-md").first();
    await expect(responseRegion).toHaveText(/[\s\S]{21,}/, { timeout: 3 * 60_000 });

    // § Trace mounts as soon as the first `response.activity` frame
    // (pipeline router emits one unconditionally at the top of every
    // turn) arrives. It renders inside the response card, not as a
    // separate section, so match the dim mono header.
    await expect(signedInPage.locator("text=§ Trace").first()).toBeVisible({ timeout: 30_000 });

    // § Judges lands fire-and-forget ~1-3s after response.completed. The
    // SPA retries fetchScores() a couple of times to give the fire-and-
    // forget writer time to settle, so give it a generous ceiling.
    await expect(signedInPage.locator("text=§ Judges").first()).toBeVisible({ timeout: 60_000 });

    // The coherence judge is always one of the two rows and names
    // itself in the row label — assert on it so a regression that
    // mounts the panel but drops the row content still fails.
    await expect(signedInPage.locator("text=coherence").first()).toBeVisible({ timeout: 60_000 });
  });

  test("Settings → Usage tab lists a window picker and loads without error", async ({ signedInPage }) => {
    // Masthead carries a "<username> ▾" button that opens a menu
    // containing "Settings". `title={signed in as ${email}}` keeps the
    // button addressable even if the username display changes.
    const userMenu = signedInPage.locator('button[title^="signed in as"]').first();
    await expect(userMenu).toBeVisible({ timeout: 10_000 });
    await userMenu.click();

    await signedInPage.locator('button:has-text("Settings")').first().click();

    // The modal lands on the Prompts tab. Click Usage.
    await expect(signedInPage.locator('h2:has-text("System prompts")').first()).toBeVisible({ timeout: 10_000 });
    await signedInPage.locator('button:has-text("Usage")').first().click();

    // Header flips to "Usage". Window picker renders three options.
    await expect(signedInPage.locator('h2:has-text("Usage")').first()).toBeVisible({ timeout: 5_000 });
    for (const label of ["last 24h", "last 7d", "last 30d"]) {
      await expect(signedInPage.locator(`button:has-text("${label}")`).first()).toBeVisible();
    }

    // The tab loads events via /usage. Three terminal states — settle
    // on any of them within 15s:
    //   - "No events in this window." (empty 24h window)
    //   - "model turns"                (summary stat label)
    //   - "Couldn't load usage"        (hard failure — fails the test)
    await expect(
      signedInPage.locator("text=/No events in this window\\.|model turns|Couldn't load usage/").first(),
    ).toBeVisible({ timeout: 15_000 });

    // Explicit regression guard: if the lambda or CloudFront route
    // breaks, we see the error header rather than one of the healthy
    // states. Match on it directly so the failure message is useful.
    const errCount = await signedInPage.locator("text=Couldn't load usage").count();
    expect(errCount).toBe(0);
  });

  test("Agent response card carries a pipeline chip", async ({ signedInPage }) => {
    await signedInPage.locator('button.tab:has-text("Agent")').first().click();
    await expect(signedInPage.locator("text=§ Question").first()).toBeVisible({ timeout: 10_000 });

    const textarea = signedInPage.locator("textarea").first();
    await textarea.click();
    await textarea.pressSequentially("Say hello.", { delay: 5 });

    const submit = signedInPage.locator("button.btn-cue").first();
    await expect(submit).toBeEnabled({ timeout: 15_000 });
    await submit.click();

    // Wait for the response text so the turn is clearly complete; the
    // pipeline chip is rendered inside the same card header as the
    // elapsed-time field. The chip text is upper-cased in CSS and
    // reads either "REWOO" or "REACT" depending on how the router
    // classified the turn.
    const responseRegion = signedInPage.locator(".response-md").first();
    await expect(responseRegion).toHaveText(/[\s\S]{3,}/, { timeout: 3 * 60_000 });

    // The chip carries `title="pipeline / transport: <path>"` on the
    // span — select by that attribute prefix so we hit the chip itself,
    // not stray text in the trace strip or docs. Chip reads either
    // "rewoo" or "react" depending on router classification; CSS does
    // the uppercasing visually.
    const chip = signedInPage.locator('span[title^="pipeline / transport:"]').first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveText(/^(rewoo|react)$/i);
  });
});
