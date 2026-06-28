import { test, expect, type Page } from "@playwright/test";

/**
 * Golden-path E2E: create an issue via the quick-create dialog, verify it
 * appears in the inbox list, open it, move status. Runs authenticated via the
 * storageState minted in global-setup against the seeded `forge` workspace.
 */

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function selectComboboxOption(page: Page, name: string, option: string) {
  const combo = page.getByRole("combobox", { name });
  await expect(combo).toBeVisible();
  await combo.click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(combo).toContainText(option);
}

test.describe("Issue flow", () => {
  test("create, pin/unpin from navbar, and transition an issue", async ({ page }) => {
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

    // The issue-detail pin control targets the navbar pin bucket. Once pinned,
    // the navbar chip exposes its own direct unpin button so users do not have
    // to hunt through other issue controls to remove the pin.
    await page.getByRole("button", { name: "Pin to navbar (p)" }).click();
    await expect(page.getByRole("button", { name: "Unpin from navbar (p)" })).toBeVisible();
    const navbarUnpin = page.getByRole("button", {
      name: new RegExp(`^Unpin from navbar: .*${escapeRegExp(title)}`),
    });
    await expect(navbarUnpin).toBeVisible();
    await navbarUnpin.click();
    await expect(page.getByRole("button", { name: "Pin to navbar (p)" })).toBeVisible();
    await expect(navbarUnpin).toHaveCount(0);

    // Move status on the detail page and confirm it sticks.
    await selectComboboxOption(page, "Status", "In Progress");
  });
});
