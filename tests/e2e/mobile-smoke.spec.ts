import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [390, 430, 768] as const;
const HEIGHT = 844;

async function expectNoDocumentHorizontalOverflow(page: Page, label: string) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const doc = document.documentElement;
          const body = document.body;
          return Math.max(
            0,
            body.scrollWidth - body.clientWidth,
            doc.scrollWidth - doc.clientWidth,
          );
        }),
      { message: `${label} should not create document-level horizontal overflow` },
    )
    .toBeLessThanOrEqual(1);
}

async function expectShellControls(page: Page, width: number) {
  await expect(page.locator("header [data-quick-create]").first()).toBeVisible();

  if (width < 768) {
    await expect(
      page.getByRole("button", { name: "Open navigation" }),
    ).toBeVisible();
  }
}

test.describe("Mobile smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("forge:view:issues", "list");
    });
  });

  for (const width of WIDTHS) {
    test(`workspace routes stay usable without document overflow at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT });

      await page.goto("/w/forge/inbox");
      await expectShellControls(page, width);
      await expect(
        page.locator("header", { hasText: "Inbox" }).last(),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /mark read/i })).toBeVisible();
      await expect(
        page.getByRole("button", { name: /this workspace/i }),
      ).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `inbox at ${width}px`);

      await page.goto("/w/forge/issues");
      await expectShellControls(page, width);
      await expect(
        page.locator("header", { hasText: "All issues" }).last(),
      ).toBeVisible();
      await expect(page.getByPlaceholder(/search/i)).toBeVisible();
      await expect(page.getByRole("button", { name: "List" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Kanban" })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `issues list at ${width}px`);

      const firstIssue = page.locator('a[href^="/w/forge/issues/"]').first();
      await expect(firstIssue).toBeVisible();
      await firstIssue.click();
      await expect(page).toHaveURL(/\/w\/forge\/issues\/[^/]+$/);
      await expectShellControls(page, width);
      await expect(page.getByRole("combobox", { name: "Status" })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Priority" })).toBeVisible();
      await expect(page.getByRole("button", { name: /focus/i })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `issue detail at ${width}px`);

      await page.goto("/w/forge/issues");
      await page.getByRole("button", { name: "Kanban" }).click();
      await expect(page.getByRole("button", { name: "List" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Kanban" })).toBeVisible();
      await expect(page.getByRole("button", { name: /new issue in/i }).first()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `issues kanban at ${width}px`);
    });
  }
});
