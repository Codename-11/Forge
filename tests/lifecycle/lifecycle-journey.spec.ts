import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const AUDIT_DIR = resolve(process.env.LIFECYCLE_AUDIT_DIR ?? "test-results/lifecycle-audit");

async function capture(page: Page, name: string) {
  mkdirSync(AUDIT_DIR, { recursive: true });
  await page.screenshot({ path: join(AUDIT_DIR, `${name}.png`), fullPage: true });
}

async function recordAccessibility(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileSync(
    join(AUDIT_DIR, `${name}-accessibility.json`),
    JSON.stringify(result.violations, null, 2),
  );
  const serious = result.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.describe("Issue lifecycle operator journey", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.setViewportSize({ width: 1440, height: 1100 });
  });

  test("returns to a complete Command Center after navigation", async ({ page }) => {
    await page.goto("/w/forge/command-center");

    const content = page.getByTestId("command-center-content");
    await expect(content).toBeVisible();
    await expect(page.getByText("Asks", { exact: true })).toBeVisible();
    await expect(page.getByText("Runtime approvals", { exact: true })).toBeVisible();
    await expect(page.getByText("Review gates", { exact: true })).toBeVisible();
    await expect(page.getByText("Stalled runs", { exact: true })).toBeVisible();
    await expect(page.getByText("FRG-9003", { exact: true })).toBeVisible();
    await expect(page.getByText("Running lifecycle regression tests").first()).toBeVisible();
    await capture(page, "01-command-center-desktop");
    await recordAccessibility(page, "01-command-center-desktop");

    await page.goto("/w/forge/issues/clifecycleactive000000000001");
    await expect(
      page.getByRole("heading", { name: "Lifecycle Lab · Agent actively working" }),
    ).toBeVisible();
    await expect(page.getByLabel("Agent workstream")).toContainText(
      "Running lifecycle regression tests",
    );

    await page.goto("/w/forge/issues/clifecyclewaiting0000000001");
    await expect(
      page.getByRole("heading", { name: "Lifecycle Lab · Waiting for user reply" }),
    ).toBeVisible();
    await expect(page.getByLabel("Agent workstream")).toContainText(/Waiting on you/i);
    await page.reload();
    await expect(page.getByLabel("Agent workstream")).toContainText(/Waiting on you/i);
    await capture(page, "02-waiting-issue-desktop");
    await recordAccessibility(page, "02-waiting-issue-desktop");

    await page.goto("/w/forge/command-center");
    await expect(page.getByText("Choose the completion-summary emphasis").first()).toBeVisible();
  });

  test("Inbox and shared notifications preserve distinct kinds of attention", async ({ page }) => {
    await page.goto("/w/forge/inbox");
    await expect(page.getByRole("heading", { name: /Needs your input/ })).toBeVisible();
    await expect(page.getByText("Choose the completion-summary emphasis")).toBeVisible();
    await capture(page, "03-inbox-desktop");
    await recordAccessibility(page, "03-inbox-desktop");

    const bell = page.getByRole("button", { name: /(?:unread|no unread) item/i });
    await bell.click();
    const drawer = page.getByRole("dialog", { name: "Activity" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("FRG-9008 stalled")).toBeVisible();
    await capture(page, "04-shared-notifications-desktop");
    await recordAccessibility(page, "04-shared-notifications-desktop");
  });

  test("completed work keeps its final handoff and terminal state", async ({ page }) => {
    await page.goto("/w/forge/issues/clifecyclecompleted00000001");
    await expect(
      page.getByRole("heading", { name: "Lifecycle Lab · Completed with final handoff" }),
    ).toBeVisible();
    await expect(page.getByText(/Completed\. The operator journey now exposes/)).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Status" })).toContainText("Done");
    await capture(page, "05-completed-issue-desktop");
    await recordAccessibility(page, "05-completed-issue-desktop");
  });

  test("attention remains usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/w/forge/command-center");
    const content = page.getByTestId("command-center-content");
    await expect(content).toBeVisible();
    await expect(page.getByText("Asks", { exact: true })).toBeVisible();
    const overflow = await page.evaluate(() =>
      Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        document.body.scrollWidth - document.body.clientWidth,
      ),
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await capture(page, "06-command-center-mobile");
    await recordAccessibility(page, "06-command-center-mobile");
  });
});
