import { expect, test } from "@playwright/test";

test("Goals and Plans expose live operations without horizontal overflow", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));

  await page.goto("/w/forge/goals?new");
  const objective = page.getByPlaceholder("e.g. Migrate auth to NextAuth v5");
  await expect(objective).toBeVisible();
  await objective.fill(`E2E live operations ${Date.now()}`);
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page).toHaveURL(/\/w\/forge\/goals\//, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Live goal operations" })).toBeVisible();
  await expect(page.getByText("Goal operations", { exact: true })).toBeVisible();

  await page.goto("/w/forge/plans");
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await page.getByPlaceholder("Plan title").fill(`E2E execution cockpit ${Date.now()}`);
  await page.getByRole("combobox", { name: "Plan template" }).click();
  await page.getByRole("option", { name: "DAG" }).click();
  await page.getByRole("button", { name: /^Create/ }).click();
  await expect(page).toHaveURL(/\/w\/forge\/plans\//, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Live plan operations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit plan", exact: true })).toBeVisible();
  await expect(page.getByText("Queued", { exact: true }).first()).toBeVisible();

  // Execution is read-first. Editing controls appear only after opting in.
  await expect(page.getByText("+ Add body…", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done editing" })).toBeVisible();
  await expect(page.getByText("+ Add body…", { exact: true }).first()).toBeVisible();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1800 });
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return Math.max(0, body.scrollWidth - body.clientWidth, doc.scrollWidth - doc.clientWidth);
    });
    expect(overflow).toBeLessThanOrEqual(1);
  }
});
