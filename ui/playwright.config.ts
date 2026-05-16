import { defineConfig, devices } from "@playwright/test";
import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Test creds + the test KS id live in e2e/.env.test (gitignored). Load
// them before Playwright reads process.env in fixtures.
dotenvConfig({ path: path.resolve(__dirname, "e2e", ".env.test") });

const BASE_URL = process.env.E2E_BASE_URL || "https://d18q1864w6gq7b.cloudfront.net";

export default defineConfig({
  testDir: "./e2e",
  // Tests touch real AWS + TwelveLabs; spend isn't free, so don't parallel-run
  // RoughCut. Each test file gets its own browser context, but in serial.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  // Real agent runs hit AgentCore Runtime + Marengo + Pegasus. A 6-beat
  // rough-cut routinely needs 60-120 s, so the per-test timeout is
  // generous. Per-assertion timeouts override this where it makes sense.
  timeout: 4 * 60_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
