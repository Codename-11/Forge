import { expect, test } from "@playwright/test";

test("workspace admins can configure PR handoff timeline comments", async ({ page }) => {
  await page.goto("/w/forge/settings/workspace");

  const policy = page.getByRole("combobox", { name: "PR handoff comment policy" });
  await expect(page.getByText("Code delivery timeline", { exact: true })).toBeVisible();
  await policy.click();
  await expect(page.getByRole("option", { name: "Off — no delivery prompt" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Recommend a handoff comment" })).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Require a comment when attaching a PR" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Automatically post a concise PR comment" }),
  ).toBeVisible();
});
