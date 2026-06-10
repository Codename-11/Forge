import { expect, test } from "@playwright/test";

test.describe("Sprints and roadmap management", () => {
  test("sprints exposes management, rollover, and collapsible backlog", async ({ page }) => {
    await page.goto("/w/forge/cycles");

    await expect(page.locator("header", { hasText: "Sprints" }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: "New sprint", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Backlog", exact: true }).click();
    await expect(page.locator("[data-cycle-backlog-panel]")).toBeVisible();
    await page.getByRole("button", { name: "Collapse backlog" }).click();
    await expect(page.locator("[data-cycle-backlog-panel]")).toHaveCount(0);

    await page.getByRole("button", { name: "Manage" }).click();
    await expect(page.getByRole("dialog", { name: "Manage sprint" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    const rollover = page.getByRole("button", { name: "Rollover incomplete" });
    await expect(rollover).toBeVisible();
    if (await rollover.isEnabled()) {
      await rollover.click();
      await expect(page.getByRole("dialog", { name: "Rollover incomplete work" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  });

  test("roadmap filters and project date editor are interactive", async ({ page }) => {
    await page.goto("/w/forge/roadmap");

    await expect(page.locator("header", { hasText: "Roadmap" }).last()).toBeVisible();
    await expect(page.getByText("Initiatives").first()).toBeVisible();

    await page.getByRole("button", { name: "Filter" }).click();
    const filters = page.getByTestId("roadmap-filters");
    await expect(filters).toBeVisible();
    await filters.locator("select").nth(1).selectOption("missing");
    await expect(filters.getByText(/of \d+ projects/)).toBeVisible();
    await filters.locator("select").nth(1).selectOption("all");

    const dateButton = page.getByRole("button", { name: /set dates|edit dates/i }).first();
    await expect(dateButton).toBeVisible();
    await dateButton.click();

    await expect(page.getByRole("dialog", { name: "Project roadmap dates" })).toBeVisible();
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("2026-08-03");
    await dates.nth(1).fill("2026-08-14");
    await page.getByRole("button", { name: "Save dates" }).click();
    await expect(page.getByText("Roadmap dates updated.")).toBeVisible();
  });
});
