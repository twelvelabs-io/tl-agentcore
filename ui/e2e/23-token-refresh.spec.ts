import { test, expect, testConfig } from "./fixtures";

/** Cognito token-refresh path. The SPA stores {access,id,refresh,
 *  expires_at} in localStorage under `tl-agentcore.tokens`. On every
 *  API call (and the initial boot), it checks whether the access token
 *  has < 60 s of life left and, if so, exchanges the refresh token for
 *  a fresh access token. This spec drives that lazy refresh by mutating
 *  the stored expires_at to be ~now, then triggering an API call (KS
 *  list) and asserting that:
 *    - the page does NOT bounce to Cognito (no full re-prompt)
 *    - localStorage gets a new token (different expires_at than the
 *      one we wrote)
 *    - the KS picker still populates (proves the new access token
 *      actually works against the backend) */

test.describe("Token refresh: silent reauth via refresh_token", () => {
  test("expiring the access token forces a silent refresh on next API call", async ({ signedInPage }) => {
    const LS_KEY = "tl-agentcore.tokens";

    // Snapshot the current stored tokens; force expires_at into the
    // past so the next getAccessToken() call has to refresh.
    const before = await signedInPage.evaluate((k) => {
      const t = JSON.parse(localStorage.getItem(k) || "null");
      if (!t) throw new Error("no tokens in localStorage");
      const stamped = { ...t, expires_at: Date.now() - 1000 };
      localStorage.setItem(k, JSON.stringify(stamped));
      return { had_refresh: !!t.refresh_token, original_expires: t.expires_at };
    }, LS_KEY);

    if (!before.had_refresh) test.skip(true, "no refresh_token on the cached session — re-run after a fresh sign-in");

    // Drive an API call by reloading the Library tab. Library reads
    // /tl/knowledge-stores + /tl/knowledge-stores/{id}/items, both of
    // which call getAccessToken() which detects the expired token and
    // exchanges the refresh_token for a fresh one.
    await signedInPage.locator('button.tab:has-text("Library")').first().click();
    await expect(signedInPage.locator('text=§ Library').first()).toBeVisible({ timeout: 15_000 });
    // Wait for the items grid to actually load — proves the API call
    // succeeded, which in turn proves the bearer was acceptable.
    await expect(signedInPage.locator("button.clip-card").first()).toBeVisible({ timeout: 30_000 });

    // We should NOT have bounced to Cognito.
    expect(signedInPage.url()).not.toContain("amazoncognito.com");

    // expires_at should have advanced past the stamped-past value.
    // The refresh write is synchronous after a successful exchange,
    // but the items query may have completed before the refresh
    // settled if the SPA fast-paths cached bearer — poll briefly.
    await expect.poll(
      async () => {
        const t = await signedInPage.evaluate(
          (k) => JSON.parse(localStorage.getItem(k) || "null"),
          LS_KEY,
        );
        return t?.expires_at;
      },
      { timeout: 10_000 },
    ).toBeGreaterThan(Date.now() + 60_000);
  });

  // Removed: `clearing tokens triggers PKCE flow and re-acquires a
  // session` — v0.3 replaced the Cognito Hosted UI redirect with the
  // in-SPA SignInScreen, so clearing tokens now renders the sign-in
  // form instead of round-tripping through amazoncognito.com. The
  // silent-refresh test above still covers the refresh_token path
  // that ships in v0.3+.
});
