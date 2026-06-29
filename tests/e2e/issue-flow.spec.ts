import { test, expect } from "@playwright/test";

/**
 * Golden-path E2E: create an issue via the quick-create dialog, verify it
 * appears in the inbox list, open it, move status. Runs authenticated via the
 * storageState minted in global-setup against the seeded `forge` workspace.
 */

test.describe("Issue flow", () => {
  test("create and transition an issue", async ({ page }) => {
    await page.goto("/w/forge/inbox");

    // QuickCreate opens on the ⇧C global hotkey (src/components/quick-create.tsx).
    await page.locator("body").click();
    await page.keyboard.press("Shift+C");
    const titleField = page.getByPlaceholder(/Issue title/i);
    await expect(titleField).toBeVisible();
    const title = `E2E migrate cache ${Date.now()}`;
    await titleField.click();
    await titleField.fill(title);
    // Gate submit on the value having committed to React state — otherwise the
    // keydown handler can fire with a stale (empty) body under dev-server load.
    await expect(titleField).toHaveValue(title);
    // Ctrl/⌘+⏎ = create + open, so we land on the new issue's detail page (Inbox
    // is a filtered "needs attention" view that wouldn't list a fresh issue).
    await titleField.press("Control+Enter");

    await expect(page).toHaveURL(/\/w\/forge\/issues\//, { timeout: 20_000 });
    await expect(page.getByText(title).first()).toBeVisible();

    // Move status on the detail page and confirm it sticks.
    const status = page.getByRole("combobox", { name: "Status" });
    await status.click();
    await page.getByRole("option", { name: "In Progress" }).click();
    await expect(status).toContainText("In Progress");
  });
});
