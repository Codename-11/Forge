import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const AUDIT_DIR = resolve(process.cwd(), "docs/audits/agent-studio-2026-07-15/after");

async function capture(page: Page, name: string) {
  await page.screenshot({
    path: resolve(AUDIT_DIR, name),
    animations: "disabled",
    fullPage: false,
  });
}

test.describe.serial("Agent Studio audit evidence", () => {
  test.beforeAll(() => mkdirSync(AUDIT_DIR, { recursive: true }));

  test("desktop configuration and operations surfaces", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto("/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole("heading", { name: "Agent fleet" })).toBeVisible();
    await expect(page.getByText("Victor").first()).toBeVisible();
    await capture(page, "01-global-agent-profiles.png");

    await page.getByRole("button", { name: "New profile" }).click();
    await expect(page.getByRole("dialog", { name: "Create agent profile" })).toBeVisible();
    await capture(page, "02-create-agent-profile.png");
    await page.keyboard.press("Escape");

    await page.getByText("Victor").first().click();
    await expect(page.getByText("Identity & execution", { exact: true })).toBeVisible();
    await capture(page, "03-agent-profile-detail.png");

    await page.getByRole("button", { name: "Edit identity" }).click();
    await expect(page.getByRole("combobox", { name: "Primary execution runtime" })).toBeVisible();
    await capture(page, "04-edit-agent-identity.png");

    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("link", { name: "Add MCP client" }).first().click();
    const clientDialog = page.getByRole("dialog", { name: "Add agent MCP client" });
    await expect(clientDialog).toBeVisible();
    await clientDialog.getByRole("button", { name: "Next" }).click();
    await clientDialog.getByRole("button", { name: "Next" }).click();
    await expect(clientDialog.locator("select")).not.toHaveValue("");
    await capture(page, "05-add-mcp-client.png");

    await page.goto("/settings/runtimes", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Runtimes" })).toBeVisible();
    await expect(page.getByText("E2E Codex Runtime", { exact: true })).toBeVisible();
    await capture(page, "06-global-runtimes.png");

    await page.goto("/w/forge/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Bound agents", { exact: true })).toBeVisible();
    await expect(page.getByText("Victor", { exact: true }).first()).toBeVisible();
    await capture(page, "07-workspace-agent-bindings.png");

    await page.getByRole("button", { name: "Configure" }).first().click();
    await expect(
      page.getByRole("switch", { name: "Toggle auto-dispatch eligibility" }).first(),
    ).toBeVisible();
    await capture(page, "08-workspace-agent-policy-expanded.png");

    await page.goto("/w/forge/settings/access", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent access" })).toBeVisible();
    await expect(page.getByText("No Agent MCP clients", { exact: true })).toBeVisible();
    await capture(page, "09-agent-access.png");

    await page.goto("/admin/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Agent governance" })).toBeVisible();
    await expect(page.getByText("Victor", { exact: true }).first()).toBeVisible();
    await capture(page, "10-instance-agent-policy.png");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
    await expect(page.getByText("Checking operations…", { exact: true })).toBeHidden();
    await expect(page.getByText("Loading workspace queues…", { exact: true })).toBeHidden();
    await expect(page.getByText("Loading agent coverage…", { exact: true })).toBeHidden();
    await expect(page.getByText("Checking runtimes…", { exact: true })).toBeHidden();
    await capture(page, "11-mission-control.png");
  });

  test("mobile profile and workspace surfaces", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Victor").first()).toBeVisible();
    await capture(page, "12-mobile-agent-profiles.png");

    await page.getByText("Victor").first().click();
    await expect(page.getByText("Identity & execution", { exact: true })).toBeVisible();
    await capture(page, "13-mobile-agent-profile-detail.png");

    await page.goto("/w/forge/settings/agents", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Bound agents", { exact: true })).toBeVisible();
    await expect(page.getByText("Victor", { exact: true }).first()).toBeVisible();
    await capture(page, "14-mobile-workspace-agent-bindings.png");
  });
});
