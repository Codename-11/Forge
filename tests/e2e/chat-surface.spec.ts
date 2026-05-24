import { test, expect } from "@playwright/test";

/**
 * The first-class Chat surface renders its shell + composer when authenticated
 * (storageState from global-setup) against the seeded `forge` workspace.
 */
test("workspace Chat route renders the shell and composer", async ({ page }) => {
  await page.goto("/w/forge/chat");

  await expect(page.getByRole("button", { name: /new conversation/i })).toBeVisible();
  await expect(page.getByTestId("chat-composer")).toBeVisible();
});
