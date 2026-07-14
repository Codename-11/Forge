import { expect, test } from "@playwright/test";

const STATES = [
  {
    name: "desktop",
    width: 1600,
    height: 2600,
    columns: 3,
    priorityColumns: 2,
    firstWidgets: ["pipeline", "whats-new", "suggestions", "quick-notes"],
  },
  {
    name: "tablet",
    width: 1024,
    height: 2600,
    columns: 2,
    priorityColumns: 2,
    firstWidgets: ["pipeline", "suggestions", "whats-new", "ideas"],
  },
  {
    name: "mobile",
    width: 390,
    height: 3000,
    columns: 1,
    priorityColumns: 1,
    firstWidgets: ["pipeline", "whats-new", "suggestions", "quick-notes"],
  },
] as const;

test("dashboard keeps priority work bounded and reflows secondary modules", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));

  for (const state of STATES) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.goto("/w/forge/dashboard");

    const cockpit = page.getByTestId("dashboard-priority-cockpit");
    const flow = page.getByTestId("dashboard-flow-board");
    await expect(cockpit).toBeVisible();
    await expect(flow).toBeVisible();
    await expect(flow.getByText("Pipeline", { exact: true }).first()).toBeVisible();

    const priorityGrid = cockpit.locator(`[data-dashboard-columns]`).first();
    await expect(priorityGrid).toBeVisible();
    const configuredPriorityColumns = Number(
      await priorityGrid.getAttribute("data-dashboard-columns"),
    );
    expect([1, 2]).toContain(configuredPriorityColumns);
    await expect
      .poll(() =>
        priorityGrid
          .locator(":scope > [data-widget-id]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-id"))),
      )
      .toEqual(["agent-attention", "agent-activity", "standup", "pulse", "today"]);
    const priorityColumns = await priorityGrid.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns;
      return tracks === "none" ? 1 : tracks.split(" ").length;
    });
    expect(priorityColumns).toBe(
      state.name === "desktop" ? configuredPriorityColumns : state.priorityColumns,
    );

    await expect(cockpit.getByTestId("dashboard-pulse")).toBeVisible();
    await expect(cockpit.getByTestId("dashboard-schedule")).toBeVisible();
    await expect(flow.locator('[data-widget-id="pulse"]')).toHaveCount(0);
    await expect(flow.locator('[data-widget-id="today"]')).toHaveCount(0);
    await expect(flow.getByTestId("dashboard-whats-new")).toBeVisible();
    await expect(cockpit.locator('[data-widget-id="whats-new"]')).toHaveCount(0);

    expect(await cockpit.locator("[data-schedule-due-item]").count()).toBeLessThanOrEqual(3);
    expect(await flow.locator("[data-whats-new-item]").count()).toBeLessThanOrEqual(4);
    expect(await flow.locator("[data-whats-new-history]").count()).toBeLessThanOrEqual(3);

    const grid = flow.locator(`[data-dashboard-columns="3"]`);
    await expect(grid).toBeVisible();
    await expect
      .poll(() =>
        grid
          .locator(":scope > [data-widget-id]")
          .evaluateAll(
            (nodes, count) =>
              nodes.slice(0, count).map((node) => node.getAttribute("data-widget-id")),
            state.firstWidgets.length,
          ),
      )
      .toEqual(state.firstWidgets);
    const renderedColumns = await grid.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns;
      return tracks === "none" ? 1 : tracks.split(" ").length;
    });
    expect(renderedColumns).toBe(state.columns);

    if (state.name === "desktop") {
      const [boardBox, suggestionsBox] = await Promise.all([
        grid.boundingBox(),
        grid.locator('[data-widget-id="suggestions"]').boundingBox(),
      ]);
      expect(boardBox).not.toBeNull();
      expect(suggestionsBox).not.toBeNull();
      expect(Math.abs((boardBox?.width ?? 0) - (suggestionsBox?.width ?? 0))).toBeLessThanOrEqual(
        1,
      );
    }

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return Math.max(0, body.scrollWidth - body.clientWidth, doc.scrollWidth - doc.clientWidth);
    });
    expect(overflow).toBeLessThanOrEqual(1);

    const overflowingWidgets = await page
      .locator("[data-widget-id]")
      .evaluateAll((nodes) =>
        nodes
          .filter(
            (node) =>
              getComputedStyle(node).display !== "none" && node.scrollWidth - node.clientWidth > 1,
          )
          .map((node) => node.getAttribute("data-widget-id")),
      );
    expect(overflowingWidgets).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath(`dashboard-${state.name}.png`),
      fullPage: true,
    });
    await page.getByTestId("dashboard-layout").screenshot({
      path: testInfo.outputPath(`dashboard-${state.name}-layout.png`),
    });
  }
});
