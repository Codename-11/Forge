import { test, expect } from "@playwright/test";

test.describe("workspace invitations", () => {
  test("admin invitation management and invalid bearer state stay clear", async ({ page }) => {
    await page.goto("/w/forge/settings/members", { waitUntil: "domcontentloaded" });

    await expect(page.getByText("Invitations", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: /invite members/i })
      .first()
      .click();

    const dialog = page.getByRole("dialog", { name: "Invite members" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/secure, expiring link/i)).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Admin" })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Member" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(dialog.getByRole("radio", { name: "Guest" })).toBeVisible();

    await page.goto("/invite/not-a-valid-invitation-token", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Invitation not found" })).toBeVisible();
    await expect(page.getByText(/ask a workspace admin to send a new invitation/i)).toBeVisible();
  });
});
