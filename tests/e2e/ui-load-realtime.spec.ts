import { expect, test, type Page } from "@playwright/test";

function observeTrpcProcedures(page: Page): Set<string> {
  const procedures = new Set<string>();
  page.on("requestfinished", (request) => {
    const url = new URL(request.url());
    const marker = "/api/trpc/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return;
    for (const procedure of decodeURIComponent(url.pathname.slice(index + marker.length)).split(
      ",",
    )) {
      procedures.add(procedure);
    }
  });
  return procedures;
}

test("issue load defers closed surfaces and stays realtime through SSE", async ({
  page,
  context,
}) => {
  await page.goto("/w/forge/inbox");

  // Closed global overlays do not mount until their first interaction, while
  // their existing keyboard contracts still open them on demand.
  const quickCreate = page.getByPlaceholder(/Issue title/i);
  const palette = page.getByPlaceholder(/Search issues, projects/i);
  await expect(quickCreate).toHaveCount(0);
  await expect(palette).toHaveCount(0);
  await page.locator("body").click();
  await page.keyboard.press("Control+K");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+C");
  await expect(quickCreate).toBeVisible();

  const title = `Realtime load contract ${Date.now()}`;
  await quickCreate.fill(title);
  await quickCreate.press("Control+Enter");
  await expect(page).toHaveURL(/\/w\/forge\/issues\//);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // A new tab gives a fresh client cache without counting requests that are
  // still settling from the just-closed Quick Create flow. Picker-only lists
  // must stay off the initial request path until their control opens.
  const issuePath = new URL(page.url()).pathname;
  const issuePage = await context.newPage();
  const procedures = observeTrpcProcedures(issuePage);
  await issuePage.goto(issuePath);
  await expect(issuePage.getByRole("heading", { name: title })).toBeVisible();
  await issuePage.waitForTimeout(500);
  expect(procedures.has("status.list")).toBe(false);
  expect(procedures.has("workspace.members")).toBe(false);
  expect(procedures.has("project.list")).toBe(false);
  expect(procedures.has("cycle.list")).toBe(false);

  const firstStatus = issuePage.getByRole("combobox", { name: "Status" });
  await firstStatus.click();
  await expect.poll(() => procedures.has("status.list")).toBe(true);
  await issuePage.getByRole("option", { name: "In Progress" }).click();
  await expect(firstStatus).toContainText("In Progress");

  // A second authenticated tab performs an out-of-band change. The first tab
  // must update from the workspace SSE event without reload or broad polling.
  const second = await context.newPage();
  await second.goto(issuePath);
  const secondStatus = second.getByRole("combobox", { name: "Status" });
  await expect(secondStatus).toContainText("In Progress");
  await secondStatus.click();
  await second.getByRole("option", { name: "Done" }).click();
  await expect(secondStatus).toContainText("Done");
  await expect(firstStatus).toContainText("Done", { timeout: 15_000 });
});
