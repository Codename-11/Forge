import { expect, test } from "@playwright/test";

test("Mission Control chat tab supports compact conversation search", async ({ page }) => {
  await page.goto("/w/forge/dashboard");

  await page.getByTestId("mission-control-pill-chat").click();

  const search = page.getByLabel("Search Mission Control chats");
  await expect(search).toBeVisible();

  await search.fill(`no-match-${Date.now()}`);
  await expect(page.getByText("No matching chats")).toBeVisible();

  await page.getByRole("button", { name: "Clear chat search" }).click();
  await expect(search).toHaveValue("");
});
