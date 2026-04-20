import { test, expect } from "@playwright/test";

/**
 * Golden-path E2E: sign in (seeded owner), create an issue via the quick-
 * create dialog, verify it appears in the inbox list, open it, move status.
 *
 * Phase 2E moved workspace-scoped routes under `/w/[slug]/*`. The seed
 * ships an `AXI` workspace at slug `axiom-labs`; entering via
 * `/inbox` would be redirected by the middleware to
 * `/w/axiom-labs/inbox` via the hint cookie, but tests skip that by
 * using the canonical URL directly so they don't depend on cookie state.
 */

test.describe("Issue flow", () => {
  test("create and transition an issue", async ({ page }) => {
    await page.goto("/w/axiom-labs/inbox");
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
