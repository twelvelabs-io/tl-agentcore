// Global Playwright setup. Creates a per-run throwaway knowledge store
// in TwelveLabs so the Library upload + mutation specs can attach,
// detach, and delete items without churning real KSes. The KS id is
// written into ui/e2e/.env.test under TEST_MUTATIONS_KS_ID so fixtures
// can pick it up.
//
// Companion _global-teardown.ts deletes the KS after the run.

import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, ".env.test");
dotenvConfig({ path: ENV_PATH });

const TL = "https://api.twelvelabs.io/v1.3";

async function tl<T = any>(method: string, p: string, body?: any, multipart = false): Promise<T> {
  const apiKey = process.env.TL_API_KEY;
  if (!apiKey) throw new Error("TL_API_KEY env var missing (set in e2e/.env.test)");
  const headers: Record<string, string> = { "x-api-key": apiKey };
  let bodyInit: any;
  if (multipart) {
    bodyInit = body as FormData;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    bodyInit = JSON.stringify(body);
  }
  const res = await fetch(`${TL}${p}`, { method, headers, body: bodyInit });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

export default async function globalSetup() {
  // TL enforces KS-name uniqueness even against soft-deleted entries, so
  // a fixed name collides forever after the first run. Suffix every run
  // with a timestamp so each one gets a guaranteed-fresh name. We use a
  // shared prefix so this file's cleanup pass can sweep up KSes that
  // earlier crashed runs failed to teardown.
  const PREFIX = "tl-agentcore-e2e-mut-";
  const MUTATIONS_KS_NAME = PREFIX + Date.now();

  // Best-effort sweep of prefix-matching KSes left behind by prior runs.
  // (Run before create so the account doesn't accumulate junk over time.)
  const list = await tl<{ data: any[] }>("GET", "/knowledge-stores?page_limit=50");
  for (const k of list.data || []) {
    if (typeof k.name === "string" && k.name.startsWith(PREFIX)) {
      try {
        const items = await tl<{ data: any[] }>("GET", `/knowledge-stores/${k._id}/items?page_limit=50`);
        for (const it of items.data || []) {
          if (it._id) await tl("DELETE", `/knowledge-stores/${k._id}/items/${it._id}`).catch(() => {});
        }
        await tl("DELETE", `/knowledge-stores/${k._id}`);
        console.log(`[e2e] swept orphan KS ${k._id} (${k.name})`);
      } catch (e) {
        console.warn(`[e2e] failed to sweep ${k._id}:`, e);
      }
    }
  }

  const ks = await tl<any>("POST", "/knowledge-stores", {
    name: MUTATIONS_KS_NAME,
    description: "Per-run throwaway for Playwright Library upload + mutation specs.",
  });
  console.log(`[e2e] mutations KS: ${ks._id} (${ks.name})`);

  // (KS is brand-new this run, so it's already empty — no drain needed.)

  // Persist the id into .env.test so a manual re-run of a subset of
  // specs (without re-running globalSetup) can still find it, AND set
  // it on process.env so worker processes spawned next inherit it.
  upsertEnv(ENV_PATH, "TEST_MUTATIONS_KS_ID", ks._id);
  process.env.TEST_MUTATIONS_KS_ID = ks._id;
  console.log(`[e2e] wrote TEST_MUTATIONS_KS_ID=${ks._id} to ${ENV_PATH}`);
}

function upsertEnv(filePath: string, key: string, value: string) {
  let content = "";
  if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, "utf-8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) content = content.replace(re, `${key}=${value}`);
  else content += `${content.endsWith("\n") || !content ? "" : "\n"}${key}=${value}\n`;
  fs.writeFileSync(filePath, content);
}
