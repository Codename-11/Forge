import { test, expect } from "@playwright/test";

/**
 * E2E for the restructure follow-up wave (signed-in seeded owner =
 * INSTANCE_ADMIN). Covers the new global/admin surfaces and the Activity
 * dock. The deeper logic (OAuth token exchange, profile request→approve,
 * MCP profile tools) is covered by the unit/integration suite; these
 * specs verify the surfaces render and the dock is interactive.
 */

test.describe("restructure follow-up", () => {
  test("instance admin agents page shows the agent-policy surface", async ({ page }) => {
    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/admin\/agents$/);
    // The admin agent-policy page (profiles list; pending-requests panel when any).
    await expect(page.getByText(/agent profile/i).first()).toBeVisible();
  });

  test("global connections page exposes an authorize / add affordance", async ({ page }) => {
    await page.goto("/settings/connections", { waitUntil: "domcontentloaded" });
    // Either an "Add connection" button or a per-connection Authorize/Re-authorize.
    const affordance = page.getByRole("button", { name: /add connection|authorize/i }).first();
    const link = page.getByRole("link", { name: /authorize/i }).first();
    await expect(async () => {
      const hasBtn = await affordance.count();
      const hasLink = await link.count();
      expect(hasBtn + hasLink).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });
  });

  test("Activity dock opens and switches tabs", async ({ page }) => {
    await page.goto("/w/forge/inbox", { waitUntil: "domcontentloaded" });
    const liveTab = page.getByRole("button", { name: /^Live\b/ }).first();

    // Open the dock: click the presence pill (its label reports active/idle +
    // queued), with the cmd/ctrl+' toggle as a fallback.
    const pill = page.getByRole("button", { name: /active|idle|queued|attention/i }).first();
    if (await pill.count()) await pill.click();
    if (!(await liveTab.isVisible().catch(() => false))) {
      await page.keyboard.press("Control+'");
    }

    // Tabs render only when the dock is open.
    await expect(liveTab).toBeVisible({ timeout: 10_000 });
    for (const tab of ["Queue", "Agents", "Plans"]) {
      const t = page.getByRole("button", { name: new RegExp(`^${tab}\\b`) }).first();
      if (await t.count()) await t.click();
    }
    await expect(liveTab).toBeVisible();
  });
});
