import { expect, test } from "@playwright/test";

test("notification drawer traps focus and restores it to the bell", async ({ page }) => {
  await page.goto("/w/forge/dashboard");

  const bell = page.getByRole("button", { name: /(?:unread|no unread) item/i });
  await expect(bell).toBeVisible();
  await bell.click();

  const dialog = page.getByRole("dialog", { name: "Activity" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null))
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(bell).toBeFocused();
});
