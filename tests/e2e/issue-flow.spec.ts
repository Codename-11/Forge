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

    // The bare issue URL opens recent Activity, and the rail itself does not
    // become a second vertical scroll container.
    const activityTab = page.getByRole("tab", { name: /Activity/ });
    const attachmentsTab = page.getByRole("tab", { name: "Attachments" });
    const tabPanel = page.getByRole("tabpanel");
    await expect(activityTab).toHaveAttribute("aria-selected", "true");
    await expect(activityTab).toHaveAttribute("tabindex", "0");
    await expect(tabPanel).toHaveAttribute("aria-labelledby", /activity-tab$/);
    const railSurface = page.getByLabel("Issue detail rail").locator(":scope > div");
    await expect(railSurface).toBeVisible();
    const railMetrics = await railSurface.evaluate((el) => ({
      clientHeight: (el as HTMLElement).clientHeight,
      scrollHeight: (el as HTMLElement).scrollHeight,
    }));
    expect(railMetrics.scrollHeight - railMetrics.clientHeight).toBeLessThanOrEqual(1);

    // Standard tab arrow navigation changes both focus and the deep-link URL.
    await activityTab.focus();
    await activityTab.press("ArrowRight");
    await expect(attachmentsTab).toHaveAttribute("aria-selected", "true");
    await expect(attachmentsTab).toBeFocused();
    await expect(page).toHaveURL(/\?tab=attachments$/);

    // Returning to the bare path restores Activity as the default.
    await page.goto(new URL(page.url()).pathname);
    await expect(activityTab).toHaveAttribute("aria-selected", "true");

    // A browser claim is a manual UI invocation. It must not be guessed as a
    // Codex Desktop/MCP connection or as runtime execution.
    const delivery = page.getByRole("region", { name: "Code work coordination" });
    await delivery.getByRole("button", { name: "Start isolated work" }).click();
    await delivery.getByLabel("Repository").fill("Codename-11/Forge");
    await delivery
      .getByRole("textbox", { name: "Branch" })
      .fill(`codex/e2e-delivery-${Date.now()}`);
    await delivery.getByRole("button", { name: "Claim work" }).click();
    await expect(delivery.locator("span").filter({ hasText: /^Manual UI$/ })).toBeVisible();
    await expect(delivery.getByText("MCP · Codex Desktop", { exact: true })).toHaveCount(0);
    await delivery.getByText("Delivery evidence", { exact: true }).click();
    await expect(delivery.getByText("no dispatched run recorded", { exact: true })).toBeVisible();

    // Move status on the detail page and confirm it sticks.
    const status = page.getByRole("combobox", { name: "Status" });
    await status.click();
    await page.getByRole("option", { name: "In Progress" }).click();
    await expect(status).toContainText("In Progress");
  });
});
