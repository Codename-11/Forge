import { expect, test, type Page } from "@playwright/test";

function monthDelta(from: Date, to: Date) {
  return (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth();
}

async function pickDate(page: Page, label: string, target: Date) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Date picker" });
  await expect(picker).toBeVisible();

  const delta = monthDelta(new Date(), target);
  const direction = delta >= 0 ? "Next month" : "Previous month";
  for (let i = 0; i < Math.abs(delta); i += 1) {
    await picker.getByRole("button", { name: direction }).click();
  }

  await picker.getByRole("button", { name: String(target.getDate()), exact: true }).click();
}

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
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() + 1, 3);
    const targetDate = new Date(now.getFullYear(), now.getMonth() + 1, 14);
    await pickDate(page, "Start date", startDate);
    await pickDate(page, "Target date", targetDate);
    await page.getByRole("button", { name: "Save dates" }).click();
    await expect(page.getByText("Roadmap dates updated.")).toBeVisible();
  });
});
