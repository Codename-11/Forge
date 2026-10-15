import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const databaseUrl =
  process.env.E2E_MANAGE_STACK === "0"
    ? process.env.DATABASE_URL
    : (process.env.E2E_DATABASE_URL ??
      "postgresql://forge:forge@localhost:55432/forge_e2e?schema=public");
if (
  !databaseUrl ||
  (process.env.E2E_MANAGE_STACK !== "0" && new URL(databaseUrl).pathname !== "/forge_e2e")
)
  throw new Error("Reminder E2E requires the disposable E2E database.");
const db = new PrismaClient({ datasourceUrl: databaseUrl });
if (process.env.E2E_MANAGE_STACK !== "0") {
  const target = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.port !== "55432" ||
    target.username !== "forge" ||
    target.password !== "forge" ||
    target.searchParams.get("schema") !== "public"
  ) {
    throw new Error("Reminder E2E requires the guarded local Postgres endpoint.");
  }
}
test.afterAll(() => db.$disconnect());

test("schedule, surface, snooze, and dismiss a personal issue reminder", async ({ page }) => {
  await page.goto("/w/forge/issues");
  await page.keyboard.press("Shift+C");
  const title = `E2E personal reminder ${Date.now()}`;
  await page.getByPlaceholder(/Issue title/).fill(title);
  await page.getByPlaceholder(/Issue title/).press("Control+Enter");
  await expect(page).toHaveURL(/\/w\/forge\/issues\//);
  await page.locator("summary", { hasText: "Remind me" }).click();
  await page.getByRole("button", { name: "In 1 hour", exact: true }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/trpc/reminder.set") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save reminder", exact: true }).click();
  const payload = await (await saved).json();
  const reminder = payload[0].result.data.json;
  await expect(page.locator("summary", { hasText: "My reminder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel reminder", exact: true })).toBeVisible();

  // Advance only this test's persisted schedule; no wall-clock sleeps or production data.
  await db.issueReminder.update({
    where: { id: reminder.id },
    data: { remindAt: new Date(Date.now() - 1000) },
  });
  await page.reload();
  await page.getByRole("button", { name: /^(?:\d+|No) unread items?$/ }).click();
  const inbox = page.getByRole("region", { name: "Your reminders" });
  const card = inbox.locator("article").filter({ hasText: title });
  await expect(inbox.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await card.getByRole("button", { name: "Snooze 1 hour", exact: true }).click();
  await expect(card).toBeHidden();
  expect(
    (await db.issueReminder.findUniqueOrThrow({ where: { id: reminder.id } })).remindAt.getTime(),
  ).toBeGreaterThan(Date.now());

  await db.issueReminder.update({
    where: { id: reminder.id },
    data: { remindAt: new Date(Date.now() - 1000) },
  });
  await page.reload();
  await page.getByRole("button", { name: /^(?:\d+|No) unread items?$/ }).click();
  await expect(inbox.getByText(title, { exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "output/playwright/axi-204-reminder-mobile.png" });
  await card.getByRole("button", { name: "Dismiss reminder", exact: true }).click();
  await expect(card).toBeHidden();
  expect(
    (await db.issueReminder.findUniqueOrThrow({ where: { id: reminder.id } })).dismissedAt,
  ).not.toBeNull();
});
