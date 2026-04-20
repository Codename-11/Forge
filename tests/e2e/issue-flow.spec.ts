import { test, expect } from "@playwright/test";

/**
 * Golden-path E2E: sign in (seeded owner), create an issue via the quick-
 * create dialog, verify it appears in the inbox list, open it, move status.
 *
 * This test assumes:
 *   - `pnpm prisma:migrate` + `pnpm prisma:seed` have been run
 *   - A dev auth provider (magic link w/ captured email) is configured
 */

test.describe("Issue flow", () => {
  test("create and transition an issue", async ({ page }) => {
    await page.goto("/inbox");
    // Sign-in handled out-of-band in dev — assume session cookie via storageState.

    await page.keyboard.press("c");
    await expect(page.getByPlaceholder("Issue title")).toBeVisible();
    await page.getByPlaceholder("Issue title").fill("E2E: migrate cache");
    await page.keyboard.press("Enter");

    await expect(page.getByText("E2E: migrate cache")).toBeVisible();
    await page.getByText("E2E: migrate cache").click();

    await page.locator("select").first().selectOption({ label: "In Progress" });
    await expect(page.locator("select").first()).toHaveValue(/.+/);
  });
});
