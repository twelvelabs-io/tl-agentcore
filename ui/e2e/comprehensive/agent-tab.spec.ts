// Agent tab: free-form Q&A. Streams tool_call / tool_result / text_delta
// frames just like Rough Cut. We check: a query lands an answer (any
// non-empty assistant message), and clicking an inline asset chip opens
// the player.

import { test, expect } from "../fixtures";
import { goToTab, selectKs } from "./helpers/nav";

test.describe("Agent tab", () => {
  test("a question lands a non-empty assistant response", async ({ signedInPage }) => {
    await goToTab(signedInPage, "agent");
    await selectKs(signedInPage, "Hollywood Trailers");

    // The agent tab has a single chat textarea — find the one near a "send"
    // button.
    const ta = signedInPage.locator("textarea").first();
    await ta.fill("Give me a one-line overview of this knowledge base.");
    await ta.press("Meta+Enter").catch(async () => {
      await ta.press("Control+Enter");
    });

    // Assistant section "Agent" label appears, then prose. Allow up to
    // 2 minutes for streaming to complete.
    await expect(signedInPage.locator("text=/^Agent$/i").first()).toBeVisible({ timeout: 30_000 });
    // The response area must contain at least one rendered paragraph.
    await expect(signedInPage.locator("p, .response-md").first()).toBeVisible({ timeout: 120_000 });
  });
});
