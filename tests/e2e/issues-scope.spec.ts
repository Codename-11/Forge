import { expect, test } from "@playwright/test";

test("lifecycle scope stays consistent when switching between list and kanban", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("forge:view:issues", "list");
  });
  await page.goto("/w/forge/issues");

  const openScope = page.getByRole("button", { name: "open", exact: true });
  const allScope = page.getByRole("button", { name: "all", exact: true });
  const visibleCompletedIssue = page
    .locator("a:visible")
    .filter({ hasText: "Webhook delivery retry backoff" });
  await expect(openScope).toHaveAttribute("aria-pressed", "true");

  await page
    .getByRole("textbox", { name: "Search open issues" })
    .fill("Webhook delivery retry backoff");
  await expect(page.getByText("No issues match this view")).toBeVisible();
  await expect(page.getByText("Webhook delivery retry backoff", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Kanban", exact: true }).click();
  await expect(page.getByText("No issues match this view")).toBeVisible();
  await expect(page.getByText("Webhook delivery retry backoff", { exact: true })).toHaveCount(0);

  await allScope.click();
  await expect(page.getByRole("textbox", { name: "Search all issues" })).toBeVisible();
  await expect(visibleCompletedIssue).toBeVisible();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(visibleCompletedIssue).toBeVisible();
});

test("project creation explains the key and recovers from validation", async ({ page }) => {
  await page.goto("/w/forge/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();

  await expect(
    page.getByText("Used in issue IDs, for example FRG-123. It cannot be changed later."),
  ).toBeVisible();

  const createProject = page.getByRole("button", { name: /^Create project/ });
  await createProject.click();
  const validationError = page.getByText("Name and key are required.", { exact: true });
  await expect(validationError).toBeVisible();

  const uniqueKey = `PW${Date.now().toString(36).slice(-5)}`.toUpperCase();
  await page.getByLabel("Name").fill("Playwright lifecycle project");
  await expect(validationError).toHaveCount(0);
  await page.getByLabel("Key").fill(uniqueKey);
  await createProject.click();

  await expect(page).toHaveURL(/\/w\/forge\/projects\/[^/?]+$/);
  await expect(
    page.getByRole("heading", { name: "Playwright lifecycle project", exact: true }),
  ).toBeVisible();
});
