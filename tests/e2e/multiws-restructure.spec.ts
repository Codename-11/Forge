import { test, expect } from "@playwright/test";

/**
 * E2E for the multi-workspace restructure (three-tier ownership):
 *   - the global "concourse" shell renders without a workspace context
 *   - cross-workspace surfaces are read-only
 *   - the workspace switcher navigates into a workspace
 *   - the /admin shell is reachable for an INSTANCE_ADMIN
 *   - an agent profile can be bound to / unbound from a workspace
 *
 * Auth is the seeded owner (owner@forge.local, instanceRole INSTANCE_ADMIN)
 * via the shared storageState. Seed adds profiles victor/mizu (bound) +
 * atlas (unbound, instance-shared) so the bind catalog has an entry.
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
    await expect(page.locator("header").locator("span", { hasText: /Instance scope/i }).first()).toBeVisible();
  });

  test("global agents page lists profiles", async ({ page }) => {
    await page.goto("/settings/agents", { waitUntil: "domcontentloaded" });
    // Seeded profiles are owned by the signed-in owner.
    await expect(page.getByText("Victor").first()).toBeVisible();
    await expect(page.getByText("Atlas").first()).toBeVisible();
  });

  test("settings scope, redirects, and dispatch defaults stay authoritative", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Personal settings", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.goto("/settings/auth", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/admin\/auth$/);
    await expect(page.getByText(/Instance scope/).first()).toBeVisible();
    await expect(page.getByText("Identity & sign-in").first()).toBeVisible();

    await page.goto("/w/forge/settings/dispatch-rules", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("radio", { name: "Capability match" })).toBeEnabled();
    await page.getByRole("radio", { name: "Priority match" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("radio", { name: "Priority match" })).toHaveAttribute("aria-checked", "true");
  });

  test("an agent profile can be bound to a workspace and unbound", async ({ page }) => {
    await page.goto("/w/forge/settings/agents", { waitUntil: "domcontentloaded" });
    // The Definition → Binding → Instance-policy explainer + catalog are the
    // page's signature.
    await expect(page.getByText("Available to bind")).toBeVisible();

    // A bound Atlas card carries links to /w/forge/agents/atlas (Chat,
    // "Open in Activity →"). Their presence (count > 0) means "bound".
    const atlasLinks = page.locator('a[href="/w/forge/agents/atlas"]');

    // Seed leaves Atlas unbound (instance-shared) → it's in the catalog with
    // a "Bind" button (only catalog rows expose one). Bind it.
    const bindButtons = page.getByRole("button", { name: /^Bind$/ });
    await expect(bindButtons.first()).toBeVisible();
    await bindButtons.first().click();

    // It is now bound: its detail links appear in the bound list.
    await expect(atlasLinks.first()).toBeVisible({ timeout: 15_000 });

    // Reload for a clean, fully-rendered bound list, then unbind via the
    // confirm dialog. (Unbind is the last assertion, so it only depends on
    // the bound-list refetch — not the catalog.)
    await page.reload({ waitUntil: "domcontentloaded" });
    const atlasCard = atlasLinks
      .first()
      .locator('xpath=ancestor::*[.//button[normalize-space()="Unbind"]][1]');
    await atlasCard.getByRole("button", { name: "Unbind" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /Unbind/ }).click();
    await expect(atlasLinks).toHaveCount(0, { timeout: 15_000 });
  });
});
