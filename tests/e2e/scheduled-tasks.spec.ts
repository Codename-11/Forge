import { expect, test } from "@playwright/test";

test("scheduled task lifecycle creates a durable issue run", async ({ page }) => {
  const name = `E2E scheduled brief ${Date.now()}`;
  await page.goto("/w/forge/scheduled-tasks");

  await expect(page.locator("header", { hasText: "Scheduled tasks" }).last()).toBeVisible();
  await page.getByRole("button", { name: "New task" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Task name").fill(name);
  await dialog.getByLabel("Created issue title").fill("E2E scheduled output");
  await dialog
    .getByLabel("Prompt / issue description")
    .fill("Create a verified issue from the scheduled-task browser contract.");
  await dialog.getByRole("combobox", { name: "Schedule frequency" }).click();
  await page.getByRole("option", { name: "At an interval" }).click();
  await dialog.getByLabel("Interval in minutes").fill("30");
  await dialog.getByRole("button", { name: "Create task" }).click();

  const card = page.locator("article", { hasText: name });
  await expect(card).toBeVisible();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Run now" }).click();
  await expect(card.getByText("Succeeded", { exact: true })).toBeVisible();

  await card.getByText(/Recent runs/).click();
  await expect(card.getByRole("link", { name: /E2E scheduled output/ })).toBeVisible();

  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card.getByText("Paused", { exact: true }).first()).toBeVisible();
  await card.getByRole("button", { name: "Resume" }).click();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: `Delete ${name}` }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByPlaceholder(name).fill(name);
  await confirmation.getByRole("button", { name: "Delete task" }).click();
  await expect(card).toHaveCount(0);
});
