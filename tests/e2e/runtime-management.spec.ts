import { test, expect } from "@playwright/test";

/**
 * Settings → Runtimes: structured runtime config panels and the
 * enable/disable kill-switch. Drives the seeded FORGE_E2E runtimes
 * (`e2e-codex-runtime`, `e2e-mock-runtime`) and creates a Hermes row for
 * tool-surface config coverage.
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

  test("Hermes tool surface config saves and persists", async ({ page }) => {
    const name = `Hermes tools ${Date.now()}`;
    await page.getByRole("button", { name: /add runtime/i }).click();

    const dialog = page.getByRole("dialog");
    await dialog.locator("select").selectOption("hermes");
    await dialog.locator("input").nth(0).fill(name);
    await dialog.locator("input").nth(1).fill("http://127.0.0.1:8642/v1");
    await expect(page.getByTestId("runtime-tool-surface-fields")).toBeVisible();
    await dialog.getByText("Local workspace tools enabled").click();
    await dialog.locator('input[placeholder="/home/bailey/forge"]').fill("/home/bailey/forge");
    await dialog.getByRole("button", { name: /create/i }).click();

    const row = page.locator("li").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("repo tools");
    await expect(row).toContainText("terminal");
    await expect(row).toContainText("filesystem");
    await expect(row).toContainText("git");

    await row.getByRole("button", { name: /^edit$/i }).click();
    await expect(page.getByTestId("runtime-tool-surface-fields")).toBeVisible();
    await expect(dialog.locator('input[placeholder="/home/bailey/forge"]')).toHaveValue(
      "/home/bailey/forge",
    );
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
