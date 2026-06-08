#!/usr/bin/env node
// loop-runner — runs the comprehensive Playwright suite, captures the
// JSON reporter output, and re-runs ONLY the tests that failed until
// they all pass. By design (operator-requested) there is no cap — Ctrl-C
// to stop. A clear iteration counter + per-iteration cost note is
// printed so the operator can decide when enough is enough.
//
// Usage:
//   node e2e/comprehensive/loop-runner.mjs
//   AWS_PROFILE=TLSolProd node e2e/comprehensive/loop-runner.mjs
//
// First iteration runs the entire comprehensive directory. Subsequent
// iterations run a `--grep` over the failed test titles. Each iteration
// writes its JSON report to /tmp/loop-runner-<n>.json for inspection.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const UI_ROOT    = path.resolve(__dirname, "..", "..");

const escapeForGrep = (s) => s.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");

function runPlaywright(reportPath, grepRegex) {
  return new Promise((resolve, reject) => {
    // Use TWO reporters: "list" streams to console so the operator sees
    // pass/fail in real time, and "json" writes the report directly to
    // `reportPath` via the reporter's `outputFile` option. Earlier we
    // tried PWTEST_JSON_OUTPUT_NAME but it's only honored when the JSON
    // reporter is configured globally — the cli `--reporter=json` flag
    // writes to stdout, which then got mixed with global-setup logs.
    const args = ["playwright", "test", "e2e/comprehensive/"];
    if (grepRegex) {
      args.push("--grep", grepRegex);
    }
    args.push(`--reporter=list,json`);
    const proc = spawn("npx", args, {
      cwd: UI_ROOT,
      env: {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      },
      stdio: "inherit",
    });
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", reject);
  });
}

function collectFailures(reportPath) {
  if (!fs.existsSync(reportPath)) {
    console.warn(`!! report file ${reportPath} missing — treating as a hard failure so the loop doesn't claim victory falsely.`);
    return { failures: ["<report-missing>"], parseOk: false };
  }
  let raw = fs.readFileSync(reportPath, "utf-8");
  // Some test setups prepend stdout chatter before the JSON when the
  // reporter writes-then-flushes; tolerate that by finding the first '{'.
  const brace = raw.indexOf("{");
  if (brace > 0) raw = raw.slice(brace);
  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    console.warn(`!! could not parse JSON report: ${e.message}`);
    return { failures: ["<report-parse-error>"], parseOk: false };
  }
  const fails = [];
  const walkSuites = (suites) => {
    for (const s of suites || []) {
      for (const spec of s.specs || []) {
        for (const t of spec.tests || []) {
          const status = (t.results || []).at(-1)?.status;
          if (status && status !== "passed" && status !== "skipped" && status !== "flaky") {
            fails.push(spec.title);
          }
        }
      }
      walkSuites(s.suites);
    }
  };
  walkSuites(report.suites);
  return { failures: Array.from(new Set(fails)), parseOk: true };
}

(async () => {
  let iteration = 0;
  let prevFails = null;
  while (true) {
    iteration += 1;
    const reportPath = `/tmp/loop-runner-${iteration}.json`;
    const grep = prevFails && prevFails.length
      ? prevFails.map((t) => `(${escapeForGrep(t)})`).join("|")
      : null;

    console.log("\n" + "=".repeat(72));
    console.log(`iteration ${iteration}` + (grep ? ` — retrying ${prevFails.length} failed tests` : " — full suite"));
    console.log("=".repeat(72));
    if (grep) {
      console.log("  Failed in prev round:");
      for (const t of prevFails) console.log(`    · ${t}`);
    }
    const t0 = Date.now();
    await runPlaywright(reportPath, grep);
    const { failures: fails, parseOk } = collectFailures(reportPath);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\niteration ${iteration} → ${fails.length} failure(s) · wall ${dt}s · report=${reportPath}`);
    if (parseOk && fails.length === 0) {
      console.log("\n✅ all tests passing. exiting.");
      process.exit(0);
    }
    if (!parseOk) {
      console.log("\n⚠️  report was missing/unparseable — refusing to claim 'all passing'. Inspect /tmp/loop-runner-*.json. Continuing the loop.");
    }
    // Sanity: if the SAME set fails three iterations in a row, warn loud
    // — operator should probably stop and investigate.
    if (prevFails && prevFails.length === fails.length &&
        prevFails.every((t) => fails.includes(t))) {
      console.log("⚠️  identical failure set as last iteration — possible deterministic bug. Ctrl-C to stop.");
    }
    prevFails = fails;
  }
})().catch((e) => {
  console.error("loop-runner crashed:", e);
  process.exit(1);
});
