import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against a DEDICATED, disposable database (`forge_e2e`) served by
 * `scripts/e2e-web.sh` on :3200 — never prod, never the shared dev:local data.
 * `globalSetup` signs in the seeded owner once and saves a storageState the
 * specs reuse, so individual tests start authenticated.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // The webServer is a production build served by `next start` (no on-demand
  // compilation), so runs are deterministic — no local retry needed. CI keeps
  // two retries purely for infra hiccups (runner contention, cold caches).
  retries: process.env.CI ? 2 : 0,
  // Sharded in CI for speed as the suite grows (see ci.yml matrix).
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    storageState: "tests/e2e/.auth/owner.json",
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    command: "bash scripts/e2e-web.sh",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // First boot migrates + seeds + runs a full `next build`, so allow headroom.
    timeout: Number(process.env.E2E_WEB_TIMEOUT_MS ?? 360_000),
    stdout: "pipe",
    stderr: "pipe",
  },
});
