import { expect, test } from "@playwright/test";

const STATES = [
  {
    name: "desktop",
    width: 1600,
    height: 2600,
    columns: 3,
    firstWidgets: ["pipeline", "whats-new", "suggestions", "today"],
  },
  {
    name: "tablet",
    width: 1024,
    height: 2600,
    columns: 2,
    firstWidgets: ["pipeline", "suggestions", "whats-new", "today"],
  },
  {
    name: "mobile",
    width: 390,
    height: 3000,
    columns: 1,
    firstWidgets: ["pipeline", "whats-new", "today", "suggestions"],
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
    await page.getByTestId("dashboard-layout").screenshot({
      path: testInfo.outputPath(`dashboard-${state.name}-layout.png`),
    });
  }
});
