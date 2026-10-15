import { expect, test, type Page } from "@playwright/test";

async function createIssue(page: Page, title: string) {
  await page.goto("/w/forge/issues");
  await page.getByRole("button", { name: "New issue ⇧C", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Quick-create Issue", exact: true });
  await input.fill(title);
  await input.press("Control+Enter");
  await expect(page).toHaveURL(/\/w\/forge\/issues\//);
  await expect(page.getByRole("heading", { level: 1, name: title, exact: true })).toBeVisible();
  return page.url();
}

test("daily issue shows files, related work and filtered discussion together", async ({ page }) => {
  const stamp = Date.now();
  const relatedTitle = `Daily related ${stamp}`;
  await createIssue(page, relatedTitle);
  const title = `Daily home maintenance ${stamp}`;
  await createIssue(page, title);
  const attachments = page.getByRole("region", { name: "Attachments", exact: true });
  const related = page.getByRole("region", { name: "Related work", exact: true });
  const automation = page.getByRole("region", { name: "Automation and delivery", exact: true });
  await expect(attachments).toBeVisible();
  await expect(related).toBeVisible();
  await expect(automation).toBeVisible();
  await expect(page.getByRole("tab", { name: "Attachments", exact: true })).toHaveCount(0);

  const files = Array.from({ length: 5 }, (_, index) => ({
    name: `maintenance-note-${index + 1}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`Disposable local daily-workflow evidence ${stamp} / ${index}`),
  }));
  await attachments.locator('input[type="file"]').setInputFiles(files);
  await expect(
    attachments.getByRole("button", { name: "View all attachments (5)", exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(attachments.getByRole("button", { name: /^Preview attachment:/ })).toHaveCount(4);
  await attachments.getByRole("button", { name: "View all attachments (5)", exact: true }).click();
  await expect(attachments.getByRole("button", { name: /^Preview attachment:/ })).toHaveCount(5);
  await attachments
    .getByRole("button", { name: "Preview attachment: maintenance-note-1.txt", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Attachment preview: maintenance-note-1.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("dialog")
      .getByText(`Disposable local daily-workflow evidence ${stamp} / 0`, { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press("Escape");
  await attachments.getByRole("button", { name: "Show fewer files", exact: true }).click();

  await related.getByRole("button", { name: "Add relation", exact: true }).first().click();
  await page.getByRole("combobox", { name: "Relation type", exact: true }).click();
  await page.getByRole("option", { name: "Related to", exact: true }).click();
  await related.getByPlaceholder("Search by key or title…").fill(relatedTitle);
  await related.getByRole("button", { name: new RegExp(relatedTitle) }).click();
  await related.getByRole("button", { name: "Add", exact: true }).click();
  await expect(related.getByRole("link", { name: new RegExp(relatedTitle) })).toBeVisible();

  await page
    .getByRole("textbox", { name: "Comment composer", exact: true })
    .fill("Replacement part ordered; follow up tomorrow.");
  await page.getByRole("button", { name: /^Comment/ }).click();
  await expect(page.getByRole("textbox", { name: "Comment composer", exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByText("Replacement part ordered; follow up tomorrow.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await expect(
    page.getByText("Replacement part ordered; follow up tomorrow.", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All activity", exact: true }).click();
  await expect(
    page.getByText("Replacement part ordered; follow up tomorrow.", { exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Discussion", exact: true }).click();
  await page.keyboard.press("2");
  await expect(attachments).toBeFocused();
  await page.keyboard.press("3");
  await expect(related).toBeFocused();
  await page.getByRole("heading", { level: 1, name: title }).scrollIntoViewIfNeeded();
  await page.locator("#issue-activity").evaluate((element) => {
    const scroller = element.closest(".overflow-y-auto");
    if (scroller) scroller.scrollTop = 0;
  });
  await page.screenshot({ path: "output/playwright/daily-workflow-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { level: 1, name: title }).scrollIntoViewIfNeeded();
  await page.locator("#issue-activity").evaluate((element) => {
    const scroller = element.closest(".overflow-y-auto");
    if (scroller) scroller.scrollTop = 0;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "output/playwright/daily-workflow-mobile.png" });
});

test("Ask an agent prepares the chosen mode without dispatching or claiming", async ({ page }) => {
  await createIssue(page, `Daily request draft ${Date.now()}`);
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/trpc\/(?:issue\.update|comment\.create|workSession\.claim)/.test(request.url())
    )
      writes.push(request.url());
  });
  const composer = page.getByRole("textbox", { name: "Comment composer", exact: true });
  await composer.fill("@victor /execute Existing draft context.");
  const mode = page.getByRole("combobox", { name: "Mode for Victor", exact: true });
  await expect(mode).toContainText("Execute");
  await page.getByText("Add agent or delivery…", { exact: true }).click();
  await page.getByRole("button", { name: /^Ask an agent/ }).click();
  await expect(page.getByRole("radio", { name: "Discuss", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("dialog").getByRole("option").filter({ hasText: "Victor" }).click();
  await expect(composer).toHaveValue(/@victor \/discuss Existing draft context\./);
  await expect(mode).toContainText("Discuss");
  expect(writes).toEqual([]);
  await expect(page.getByRole("button", { name: "Discussion", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
