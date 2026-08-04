// Global teardown: drain + delete the per-run throwaway mutations KS
// and any S3 uploads it created. Best-effort: a failed teardown
// shouldn't make the test run fail (we log + continue), since the next
// run's _global-setup.ts is idempotent.

import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenvConfig({ path: path.resolve(__dirname, ".env.test") });

const TL = "https://api.twelvelabs.io/v1.3";

async function tl<T = any>(method: string, p: string): Promise<T | null> {
  const apiKey = process.env.TL_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${TL}${p}`, { method, headers: { "x-api-key": apiKey } });
    if (!res.ok) {
      console.warn(`[e2e teardown] ${method} ${p} → ${res.status}`);
      return null;
    }
    return res.status === 204 ? (null as any) : (res.json() as Promise<T>);
  } catch (e) {
    // Template literal, not util.format — Semgrep pattern is a false
    // positive here (no format specifiers evaluated).
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
    console.warn(`[e2e teardown] ${method} ${p}:`, e);
    return null;
  }
}

export default async function globalTeardown() {
  const ksId = process.env.TEST_MUTATIONS_KS_ID;
  if (!ksId) return;

  // Drain items first (TL doesn't cascade delete attachments).
  const items = await tl<{ data: any[] }>("GET", `/knowledge-stores/${ksId}/items?page_limit=50`);
  for (const it of items?.data || []) {
    if (it._id) await tl("DELETE", `/knowledge-stores/${ksId}/items/${it._id}`);
  }
  // Delete the KS itself.
  await tl("DELETE", `/knowledge-stores/${ksId}`);
  console.log(`[e2e teardown] deleted mutations KS ${ksId}`);
}
