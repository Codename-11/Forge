import { test, expect } from "@playwright/test";

/**
 * E2E for the multi-workspace restructure (three-tier ownership):
 *   - the global "concourse" shell renders without a workspace context
 *   - cross-workspace surfaces are read-only
 *   - the workspace switcher navigates into a workspace
 *   - the /admin shell is reachable for an INSTANCE_ADMIN
 *   - Mission Control can bind / unbind a profile while workspace settings
 *     remain policy-only
 *
 * Auth is the seeded owner (owner@forge.local, instanceRole INSTANCE_ADMIN)
 * via the shared storageState. Seed adds profiles victor/mizu (bound) +
 * atlas (unbound, instance-shared) so Mission Control can adopt it.
 */

test.describe("multi-workspace restructure", () => {
  test("global Mission Control renders without a workspace and is read-only", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Mission Control page header (no /w/<slug> in the URL).
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
    // Read-only badge in the global top bar.
    await expect(page.getByText("Read-only across workspaces", { exact: true })).toBeVisible();
  });

  test("workspace switcher navigates into a workspace", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // The concourse rail lists the user's workspaces; clicking one enters it.
    const forgeLink = page.locator('a[href^="/w/forge"]').first();
    await expect(forgeLink).toBeVisible();
    await forgeLink.click();
    await expect(page).toHaveURL(/\/w\/forge(\/|$)/);
  });

  test("instance admin shell is reachable for an admin", async ({ page }) => {
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/admin$/);
    // Admin shell brand + the instance-scope warning bar.
    await expect(page.getByText("Instance admin").first()).toBeVisible();
    await expect(
      page
        .locator("header")
        .locator("span", { hasText: /Instance scope/i })
        .first(),
    ).toBeVisible();
  });

  test("global agents page lists profiles", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent fleet" })).toBeVisible();
    // Seeded profiles are owned by the signed-in owner.
    await expect(page.getByText("Victor").first()).toBeVisible();
    await expect(page.getByText("Atlas").first()).toBeVisible();
  });

  test("settings scope, redirects, and dispatch defaults stay authoritative", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Account & identity", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.goto("/settings/auth", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/admin\/auth$/);
    await expect(page.getByText(/Instance scope/).first()).toBeVisible();
    await expect(page.getByText("Identity & sign-in").first()).toBeVisible();

    await page.goto("/w/forge/settings/dispatch-rules", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("radio", { name: "Capability match" })).toBeEnabled();
    await page.getByRole("radio", { name: "Priority match" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("radio", { name: "Priority match" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("an agent profile can be bound to a workspace and unbound", async ({ page }) => {
    await page.goto("/w/forge/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent policy" })).toBeVisible();
    await expect(page.getByText("Available to bind", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Bind$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unbind" })).toHaveCount(0);

    await page.goto("/agents", { waitUntil: "domcontentloaded" });
    await page.locator('a[href^="/agents/"]', { hasText: "Atlas" }).first().click();
    await expect(page.getByText("Global profile", { exact: true }).first()).toBeVisible();

    // Seed leaves Atlas unbound. Mission Control owns adoption into Forge.
    await page.getByRole("combobox", { name: "Workspace to bind" }).click();
    await page.getByRole("option", { name: /Forge\s+FRG/ }).click();
    await page.getByRole("button", { name: /^Bind$/ }).click();

    await expect(page.getByRole("link", { name: "Workspace policy" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("link", { name: "Add MCP client" })).toBeVisible();

    await page.getByRole("button", { name: "Unbind" }).click();
    await page
      .getByRole("alertdialog", { name: /Unbind from Forge/ })
      .getByRole("button", { name: /^Unbind/ })
      .click();
    await expect(page.getByText("Not bound to any workspace", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });
});
