import { expect, test } from "@playwright/test";

function uniqueLetters() {
  let value = Date.now();
  let out = "";
  while (out.length < 5) {
    out += String.fromCharCode(65 + (value % 26));
    value = Math.floor(value / 26);
  }
  return `P${out}`;
}

test("creates a personal workspace and supports the Today flow", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const suffix = Date.now();
  const slug = `personal-e2e-${suffix}`;

  await page.goto("/settings/workspaces");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByRole("button", { name: /For myself/ }).click();
  await page.getByLabel("Workspace name").fill(`Personal E2E ${suffix}`);
  await page.getByLabel("Workspace key").fill(uniqueLetters());
  await page.getByLabel("Workspace slug").fill(slug);
  await page.locator("form").getByRole("button", { name: "Create workspace", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/w/${slug}/inbox$`));
  await page.goto(`/w/${slug}/dashboard`);
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent companion" })).toBeVisible();
  await expect(page.getByText("New task", { exact: true })).toBeVisible();
  // Route changes intentionally abort in-flight tRPC requests from the prior
  // settings/inbox screens. Only inspect errors from the settled Today flow.
  browserErrors.length = 0;

  await page.getByLabel("Task title").fill("Book dentist appointment");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Book dentist appointment", { exact: true })).toBeVisible();

  await page.getByLabel("Complete Book dentist appointment").click();
  await expect(page.getByText("Book dentist appointment", { exact: true })).toBeHidden();

  await page.getByPlaceholder("Capture a note…").fill("Ask about weekend availability");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Ask about weekend availability", { exact: true })).toBeVisible();

  await page.getByTitle("Collapse agent companion").click();
  await expect(page.getByRole("heading", { name: "Agent companion" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Agent", exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
