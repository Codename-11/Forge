import { expect, test } from "@playwright/test";

const STATES = [
  { name: "desktop", width: 1600, height: 1800, split: true },
  { name: "tablet", width: 1024, height: 2200, split: false },
  { name: "mobile", width: 390, height: 2600, split: false },
] as const;

test("dashboard preserves operator-home hierarchy without gaps or duplicate work", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));

  for (const state of STATES) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.goto("/w/forge/dashboard");

    const home = page.getByTestId("dashboard-operator-home");
    const work = page.getByTestId("dashboard-work-lanes");
    const operations = page.getByTestId("dashboard-live-operations");
    const attention = page.getByTestId("dashboard-attention-rail");
    const health = page.getByTestId("dashboard-health-drawer");

    await expect(home).toBeVisible();
    await expect(work).toBeVisible();
    await expect(page.getByTestId("dashboard-recommended-next")).toBeVisible();
    await expect(attention).toBeVisible();
    await expect(health).toBeVisible();
    await expect(health.getByText("Pipeline", { exact: true })).toBeVisible();
    await expect(health.getByText("Throughput", { exact: true })).toBeVisible();
    await expect(health.getByText("Standup", { exact: true })).toBeVisible();
    await expect(health.getByText("What's new", { exact: true })).toBeVisible();

    const issueIds = await work
      .locator("[data-dashboard-issue-id]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-dashboard-issue-id")));
    expect(issueIds).toEqual([...new Set(issueIds)]);

    const [workBox, operationsBox, healthBox, homeBox] = await Promise.all([
      work.boundingBox(),
      operations.boundingBox(),
      health.boundingBox(),
      home.boundingBox(),
    ]);
    expect(workBox).not.toBeNull();
    expect(operationsBox).not.toBeNull();
    expect(healthBox).not.toBeNull();
    expect(homeBox).not.toBeNull();

    if (state.split) {
      expect(workBox!.x).toBeLessThan(operationsBox!.x);
      expect(Math.abs(workBox!.y - operationsBox!.y)).toBeLessThanOrEqual(1);
    } else {
      expect(operationsBox!.y).toBeGreaterThan(workBox!.y + workBox!.height - 1);
    }
    expect(healthBox!.y).toBeGreaterThan(
      Math.max(workBox!.y + workBox!.height, operationsBox!.y + operationsBox!.height) - 1,
    );
    expect(Math.abs(healthBox!.width - homeBox!.width)).toBeLessThanOrEqual(1);

    const drawerButton = health.getByRole("button", { name: /Workspace health/ });
    await expect(drawerButton).toHaveAttribute("aria-expanded", "true");
    await drawerButton.click();
    await expect(drawerButton).toHaveAttribute("aria-expanded", "false");
    await drawerButton.click();
    await expect(drawerButton).toHaveAttribute("aria-expanded", "true");

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return Math.max(0, body.scrollWidth - body.clientWidth, doc.scrollWidth - doc.clientWidth);
    });
    expect(overflow).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: testInfo.outputPath(`dashboard-${state.name}.png`),
      fullPage: true,
    });
    await home.screenshot({ path: testInfo.outputPath(`dashboard-${state.name}-layout.png`) });
  }
});
