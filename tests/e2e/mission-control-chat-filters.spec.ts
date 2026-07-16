import { expect, test } from "@playwright/test";

test("Mission Control chat tab previews chats and links to full search", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("forge.pwa.offline-pages.prompted", "1");
  });
  await page.goto("/w/forge/dashboard");

  await page.getByTestId("mission-control-pill-chat").click();

  await expect(page.getByLabel("Search Mission Control chats")).toHaveCount(0);

  const fullChat = page.getByRole("link", { name: /full chat/i });
  await expect(fullChat).toBeVisible();
  await fullChat.click();

  await expect(page).toHaveURL(/\/w\/forge\/chat/);
  await expect(page.getByPlaceholder(/Search chats/)).toBeVisible();
});

test("full chat exposes understandable native session classifications", async ({ page }) => {
  await page.goto("/w/forge/chat");
  const filter = page.getByRole("combobox", {
    name: "Filter conversations by session type",
  });
  await expect(filter).toBeVisible();
  await filter.click();
  for (const label of [
    "All session types",
    "Interactive chat",
    "Issue work",
    "Background",
    "Other",
  ]) {
    await expect(page.getByRole("option", { name: label })).toBeVisible();
  }
  await page.getByRole("option", { name: "Interactive chat" }).click();
  await expect(filter).toContainText("Interactive chat");
  await filter.click();
  await page.getByRole("option", { name: "Other" }).click();
  await expect(filter).toContainText("Other");
});
