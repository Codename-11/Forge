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
    await expect(page.getByRole("heading", { name: "Agent fleet" })).toBeVisible();
    await expect(page.getByText("Global control plane", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "New profile" }).click();
    const createDialog = page.getByRole("dialog", { name: "Create agent profile" });
    await createDialog.getByPlaceholder("Review Bot").fill(name);
    await createDialog.getByPlaceholder("review-bot").fill(profileKey);
    await createDialog.getByRole("button", { name: "Create profile" }).click();

    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.getByText(name, { exact: true }).click();
    await expect(page).toHaveURL(/\/agents\/[^/]+$/);
    await expect(page.getByText("Global profile", { exact: true }).first()).toBeVisible();

    const detailUrl = new URL(page.url());
    const profileId = detailUrl.pathname.split("/").at(-1)!;
    await page.goto(`/settings/agents/${profileId}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(`/agents/${profileId}`);

    await page.getByRole("combobox", { name: "Workspace to bind" }).click();
    await page.getByRole("option", { name: /Forge\s+FRG/ }).click();
    await page.getByRole("button", { name: "Bind", exact: true }).click();
    await expect(page.getByText("Forge", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Workspace policy" })).toBeVisible();

    await page.getByRole("button", { name: "Unbind" }).click();
    const unbindDialog = page.getByRole("alertdialog", { name: /Unbind from Forge/ });
    await unbindDialog.getByRole("button", { name: /^Unbind/ }).click();
    await expect(page.getByText("Not bound to any workspace", { exact: true })).toBeVisible();

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
    await expect(page.getByRole("link", { name: "Manage profiles & bindings" })).toBeVisible();
    await expect(page.getByText("Available to bind", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent governance" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Manage" }).first()).toBeVisible();
  });
});
