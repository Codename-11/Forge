import { test, expect } from "@playwright/test";

/**
 * Settings → Runtimes: the Codex sandbox/approval config panel and the
 * enable/disable kill-switch shipped with the secure-Codex work. Drives the
 * seeded FORGE_E2E runtimes (`e2e-codex-runtime`, `e2e-mock-runtime`).
 */
test.describe("Runtime management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/w/forge/settings/runtimes");
    await expect(page.getByTestId("runtime-row-e2e-codex-runtime")).toBeVisible();
  });

  test("Codex sandbox config panel saves and persists", async ({ page }) => {
    const row = page.getByTestId("runtime-row-e2e-codex-runtime");
    await row.getByRole("button", { name: /^edit$/i }).click();

    // Panel only renders for the codex-app-server adapter.
    await expect(page.getByTestId("codex-sandbox-fields")).toBeVisible();
    const mode = page.getByTestId("codex-sandbox-mode");
    await mode.selectOption("workspace-write");
    await page.getByRole("button", { name: /save/i }).click();

    // Reopen and confirm the choice persisted (round-trips Runtime.config).
    await expect(page.getByTestId("codex-sandbox-fields")).toBeHidden();
    await row.getByRole("button", { name: /^edit$/i }).click();
    await expect(page.getByTestId("codex-sandbox-mode")).toHaveValue("workspace-write");
  });

  test("enable/disable toggles the kill-switch", async ({ page }) => {
    const row = page.getByTestId("runtime-row-e2e-mock-runtime");

    // Starts enabled (seed clears disabledAt). Disable it.
    await row.getByTestId("runtime-toggle-enabled").click();
    await expect(row.getByTestId("runtime-disabled-badge")).toBeVisible();

    // Re-enable; badge clears.
    await row.getByTestId("runtime-toggle-enabled").click();
    await expect(row.getByTestId("runtime-disabled-badge")).toBeHidden();
  });
});
