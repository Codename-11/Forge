import { test, expect } from "@playwright/test";

/**
 * Settings → Data: the admin-gated export produces a portable JSON snapshot
 * of the workspace. Exercises the dataPortability router end-to-end through
 * the UI (download). Import is additive + destructive-safe, so the browser
 * test stays on export; import remapping is covered by integration tests.
 */
test("exports the workspace to a JSON download", async ({ page }) => {
  await page.goto("/w/forge/settings/data");

  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: /export to json/i }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/forge-frg-.*\.json/i);
});
