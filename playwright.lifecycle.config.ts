import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.LIFECYCLE_PORT ?? 3300);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/lifecycle",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-lifecycle" }]],
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "test-results/lifecycle",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    storageState: "tests/e2e/.auth/owner.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    command: "bash scripts/lifecycle-lab.sh --fresh --production",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 420_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
