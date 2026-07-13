import { expect, test } from "@playwright/test";

const STATES = [
  { name: "desktop", width: 1600, height: 2200, liveColumns: 3, contextColumns: 12 },
  { name: "tablet", width: 1024, height: 2200, liveColumns: 2, contextColumns: 1 },
  { name: "mobile", width: 390, height: 2600, liveColumns: 1, contextColumns: 1 },
] as const;

test("command center stays organized across viewport widths", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));

  for (const state of STATES) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.goto("/w/forge/command-center");

    const content = page.getByTestId("command-center-content");
    const priority = page.getByTestId("command-center-priority");
    const live = page.getByTestId("command-center-live-operations");
    const liveModules = page.getByTestId("command-center-live-modules");
    const context = page.getByTestId("command-center-context");
    const contextGrid = page.getByTestId("command-center-context-grid");

    await expect(content).toBeVisible();
    await expect(priority.getByText("Attention queue", { exact: true })).toBeVisible();
    await expect(live).toBeVisible();
    await expect(context).toBeVisible();
    await expect(live.getByText("Never acknowledged", { exact: true })).toHaveCount(0);

    // Attention data is intentionally mutable across the suite. Empty seeded
    // databases show the section-level empty state; databases with work render
    // only populated categories, never placeholder columns for empty ones.
    const attentionGroups = priority.locator("[data-attention-group]");
    const attentionGroupCount = await attentionGroups.count();
    expect(attentionGroupCount).toBeLessThanOrEqual(4);
    if (attentionGroupCount === 0) {
      await expect(priority.getByText("Nothing waiting on you.", { exact: true })).toBeVisible();
    } else {
      await expect(attentionGroups.first()).toBeVisible();
    }

    for (const module of ["goals", "runs", "due"] as const) {
      expect(
        await live.locator(`[data-command-module-item="${module}"]`).count(),
      ).toBeLessThanOrEqual(4);
    }
    expect(
      await context.locator('[data-command-module-item="artifacts"]').count(),
    ).toBeLessThanOrEqual(6);
    await expect(context.getByText("Agent work", { exact: true })).toBeVisible();
    await expect(content.locator("aside")).toHaveCount(0);

    const renderedLiveColumns = await liveModules.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns;
      return tracks === "none" ? 1 : tracks.split(" ").length;
    });
    expect(renderedLiveColumns).toBe(state.liveColumns);

    const renderedContextColumns = await contextGrid.evaluate((node) => {
      const tracks = getComputedStyle(node).gridTemplateColumns;
      return tracks === "none" ? 1 : tracks.split(" ").length;
    });
    expect(renderedContextColumns).toBe(state.contextColumns);

    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return Math.max(0, body.scrollWidth - body.clientWidth, doc.scrollWidth - doc.clientWidth);
    });
    expect(overflow).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: testInfo.outputPath(`command-center-${state.name}.png`),
      fullPage: true,
    });
    await content.screenshot({
      path: testInfo.outputPath(`command-center-${state.name}-content.png`),
    });
  }
});
