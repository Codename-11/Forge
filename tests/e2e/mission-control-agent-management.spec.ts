import { expect, test } from "@playwright/test";

test.describe.serial("Mission Control agent management", () => {
  test("redirects Agent Studio links and manages the profile binding lifecycle", async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const name = `Fleet E2E ${suffix}`;
    const profileKey = `fleet-e2e-${suffix}`;

    await page.goto("/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await expect(
      page.getByText("Ownership, catalog availability, and workspace access are separate.", {
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Connect via MCP", exact: true }).click();
    await page.getByRole("combobox", { name: "Setup workspace" }).click();
    await page.getByRole("option", { name: /Forge\s+FRG/ }).click();
    await page.getByRole("button", { name: "Create a new agent", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create agent profile" });
    await createDialog.getByPlaceholder("Review Bot").fill(name);
    await createDialog.getByPlaceholder("review-bot").fill(profileKey);
    await createDialog.getByRole("button", { name: "Create profile" }).click();

    await expect(page).toHaveURL(/\/agents\/[^/?]+\?/);
    const createdProfileId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.goto("/agents");
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 900, height: 650 });
    const fleetScrollRegion = page.getByTestId("agent-fleet-scroll-region");
    await expect
      .poll(() =>
        fleetScrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    await fleetScrollRegion.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect
      .poll(() => fleetScrollRegion.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await page.getByText(name, { exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/[^/]+$/);
    await expect(page.getByText("Identity & execution", { exact: true })).toBeVisible();
    const profileScrollRegion = page.getByTestId("agent-profile-scroll-region");
    await expect
      .poll(() =>
        profileScrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    await profileScrollRegion.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect
      .poll(() => profileScrollRegion.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    const detailUrl = new URL(page.url());
    const profileId = detailUrl.pathname.split("/").at(-1)!;
    expect(profileId).toBe(createdProfileId);
    await page.goto(`/settings/agents/${profileId}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(`/agents/${profileId}`);

    await page.getByRole("combobox", { name: "Workspace to add" }).click();
    await page.getByRole("option", { name: /Forge\s+FRG/ }).click();
    await page.getByRole("button", { name: "Add access", exact: true }).click();
    await expect(page.getByText("Forge", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Workspace policy" })).toBeVisible();

    await page.getByRole("button", { name: "Remove access", exact: true }).click();
    const unbindDialog = page.getByRole("alertdialog", { name: /Unbind from Forge/ });
    await unbindDialog.getByRole("button", { name: /^Unbind/ }).click();
    await expect(page.getByText("No visible workspace access", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Remove profile" }).click();
    const removeDialog = page.getByRole("alertdialog", { name: `Remove ${name}?` });
    await removeDialog.getByRole("button", { name: /^Remove profile/ }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByText(name, { exact: true })).toBeHidden();
  });

  test("keeps workspace settings policy-only and instance admin governance-only", async ({
    page,
  }) => {
    await page.goto("/w/forge/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent policy" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage agents & workspace access" }),
    ).toBeVisible();
    await expect(page.getByText("Available to bind", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent governance" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Manage" }).first()).toBeVisible();
  });
});
