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
  globalSetup:    "./e2e/_global-setup.ts",
  globalTeardown: "./e2e/_global-teardown.ts",

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
      // Curated numbered suite (01-*.spec.ts … 34-*.spec.ts). The
      // comprehensive/ subdirectory is a separate regime with its own
      // Bedrock-Claude semantic reasoner — run it via
      // `npm run test:e2e:comprehensive` explicitly, not as part of
      // `make check-fast`.
      testIgnore: ["comprehensive/**"],
    },
    // Firefox + WebKit projects run a curated smoke set, not the full
    // suite. Goal: catch obvious cross-browser breakage (CSS variable
    // fallback, focus management, FormData uploads) without booking
    // multiple hours of agent runs per CI cycle on browsers where HLS
    // playback + WebSocket streaming behave differently.
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: [
        "01-signin.spec.ts",
        "02-ks-picker.spec.ts",
        "07-agent-tab.spec.ts",
        "11-library.spec.ts",
        "18-keyboard-shortcuts.spec.ts",
      ],
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: [
        "01-signin.spec.ts",
        "02-ks-picker.spec.ts",
        "07-agent-tab.spec.ts",
        "11-library.spec.ts",
        "18-keyboard-shortcuts.spec.ts",
      ],
    },
  ],
});
