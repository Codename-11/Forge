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
