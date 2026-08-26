import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("project and integration access management", () => {
  test("project access explains visibility, roles, and impact before changing access", async ({
    page,
  }) => {
    await page.goto("/w/forge/projects");
    await page.getByRole("link", { name: /CORE.*Core Platform/i }).click();

    await expect(page.getByRole("link", { name: "Access" })).toBeVisible();
    await page.getByRole("link", { name: "Access" }).click();
    await expect(page).toHaveURL(/\/w\/forge\/projects\/[^/]+\/access$/);
    await expect(page.getByRole("heading", { name: "Project access" })).toBeVisible();

    const workspaceVisibility = page.getByRole("radio", { name: /Workspace/ });
    const restrictedVisibility = page.getByRole("radio", { name: /Restricted/ });
    await expect(workspaceVisibility).toHaveAttribute("aria-checked", "true");
    await expect(restrictedVisibility).toHaveAttribute("aria-checked", "false");

    await page.getByRole("button", { name: "Add person" }).first().click();
    await expect(page.getByRole("dialog", { name: "Add project access" })).toBeVisible();
    await page.getByRole("combobox", { name: "Person" }).click();
    await page.getByRole("option", { name: /Priya PM/ }).click();
    await page.getByRole("combobox", { name: "Project role" }).click();
    await expect(page.getByText("View this project and its issues")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await restrictedVisibility.click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Members without a direct role will lose access");
    await expect(confirmation).toContainText("1 person");
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(workspaceVisibility).toHaveAttribute("aria-checked", "true");
  });

  test("access management is responsive and has no serious accessibility violations", async ({
    page,
  }, testInfo) => {
    await page.goto("/w/forge/projects");
    await page.getByRole("link", { name: /CORE.*Core Platform/i }).click();
    await page.getByRole("link", { name: "Access" }).click();
    await page.setViewportSize({ width: 375, height: 812 });

    await expect(page.getByRole("radiogroup", { name: "Project visibility" })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .disableRules(["color-contrast", "link-in-text-block"])
      .analyze();
    await testInfo.attach("project-access-axe.json", {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  test("connections explain credential consent separately from mappings", async ({ page }) => {
    await page.goto("/w/forge/settings/connections");
    await expect(page.getByText("Credential access", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Credential-owner consent sets the ceiling. Workspace grants decide who can use it and where.",
      ),
    ).toBeVisible();
    await expect(page.getByText("No credential authorizations")).toBeVisible();
  });
});
