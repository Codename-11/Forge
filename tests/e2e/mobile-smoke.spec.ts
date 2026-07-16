import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [360, 390, 430] as const;
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
  await expect(page.getByRole("button", { name: "New issue" }).first()).toBeVisible();

  if (width < 768) {
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  }
}

async function openSettingsNavigation(page: Page) {
  await page.getByRole("button", { name: /Browse/ }).click();
  await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible();
}

async function createIssueFromMobileTopbar(page: Page, title: string) {
  await page.getByRole("button", { name: "New issue" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const titleField = page.getByPlaceholder(/Issue title/i);
  await titleField.fill(title);
  await expect(titleField).toHaveValue(title);
  await titleField.press("Control+Enter");
  await expect(page).toHaveURL(/\/w\/forge\/issues\//, { timeout: 20_000 });
  await expect(page.getByText(title).first()).toBeVisible();
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

      await page.goto("/w/forge/dashboard");
      await expectShellControls(page, width);
      await expect(page.locator("header", { hasText: "Dashboard" }).last()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `dashboard at ${width}px`);

      await page.goto("/w/forge/inbox");
      await expectShellControls(page, width);
      await expect(page.locator("header", { hasText: "Inbox" }).last()).toBeVisible();
      await expect(page.getByRole("button", { name: /mark read/i })).toBeVisible();
      await expect(page.getByRole("button", { name: /this workspace/i })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `inbox at ${width}px`);

      await page.goto("/w/forge/issues");
      await expectShellControls(page, width);
      await expect(page.locator("header", { hasText: "All issues" }).last()).toBeVisible();
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
      await expect(page.getByLabel("Issue detail rail")).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `issue detail at ${width}px`);

      await page.goto("/w/forge/issues");
      await page.getByRole("button", { name: "Kanban" }).click();
      await expect(page.getByRole("button", { name: "List" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Kanban" })).toBeVisible();
      await expect(page.getByRole("button", { name: /new issue in/i }).first()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `issues kanban at ${width}px`);

      await page.goto("/w/forge/command-center");
      await expectShellControls(page, width);
      await expect(page.locator("header", { hasText: "Command center" }).last()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `command center at ${width}px`);

      await page.goto("/w/forge/agents");
      await expectShellControls(page, width);
      await expect(page.locator("header", { hasText: "Agents" }).last()).toBeVisible();
      await expect(page.getByRole("link", { name: /@victor/i }).first()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `agents at ${width}px`);

      await page.goto("/w/forge/settings/runtimes");
      await expectShellControls(page, width);
      await expect(page.locator("header", { hasText: "Runtimes" }).last()).toBeVisible();
      await expect(page.getByTestId("runtime-row-e2e-codex-runtime")).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `runtimes at ${width}px`);
    });

    test(`global activity, instance settings, and admin surfaces stay usable at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: HEIGHT });

      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Mission Control" })).toBeVisible();
      const activityPill = page.getByTitle("Activity · live runs and changes · shortcut G then 5");
      await expect(activityPill).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `mission control activity pill at ${width}px`);

      await activityPill.click();
      await expect(page).toHaveURL(/\/activity$/);
      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `activity feed at ${width}px`);

      await page.goto("/agents");
      await expect(page.getByRole("heading", { name: "Agent fleet" })).toBeVisible();
      await page.getByRole("button", { name: "Open menu" }).click();
      const globalMenu = page.getByRole("dialog", { name: "Menu" });
      await expect(globalMenu).toBeVisible();
      await expect(globalMenu.getByRole("link", { name: /^Agents/ })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `global agent fleet at ${width}px`);
      await page.keyboard.press("Escape");

      await page.goto("/settings/runtimes");
      await openSettingsNavigation(page);
      await expect(page.getByPlaceholder("Search settings")).toBeVisible();
      await expect(page.locator("main").getByText("Runtimes").first()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `instance runtimes settings at ${width}px`);

      await page.goto("/settings/appearance");
      await openSettingsNavigation(page);
      await expect(page.getByPlaceholder("Search settings")).toBeVisible();
      await expect(page.locator("main").getByText("Appearance").first()).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `instance appearance settings at ${width}px`);

      await page.goto("/admin");
      await expect(page.getByText("Instance scope", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Forge · self-hosted" })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `admin overview at ${width}px`);

      await page.goto("/admin/runtimes");
      await expect(page.getByText("Instance scope", { exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Runtimes" })).toBeVisible();
      await expectNoDocumentHorizontalOverflow(page, `admin runtimes at ${width}px`);
    });
  }

  test("primary phone-width issue workflow supports create, edit, comment, status, assignment, agents, and runtimes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: HEIGHT });
    const title = `Mobile UX ${Date.now()}`;
    const editedTitle = `${title} edited`;
    const comment = `Mobile comment ${Date.now()}`;

    await page.goto("/w/forge/issues");
    await expectShellControls(page, 390);
    await createIssueFromMobileTopbar(page, title);
    await expectNoDocumentHorizontalOverflow(page, "created issue detail at 390px");

    await page.getByRole("heading", { name: title }).click();
    const titleInput = page.locator("form input").first();
    await expect(titleInput).toBeVisible();
    await titleInput.fill(editedTitle);
    await titleInput.press("Enter");
    await expect(page.getByRole("heading", { name: editedTitle })).toBeVisible();

    await page.getByLabel("Comment composer").fill(comment);
    await page.getByRole("button", { name: /^Comment/ }).click();
    await expect(page.locator("span", { hasText: comment }).first()).toBeVisible();

    const status = page.getByRole("combobox", { name: "Status" });
    await status.click();
    await page.getByRole("option", { name: "In Progress" }).click();
    await expect(status).toContainText("In Progress");

    await page.getByTitle(/Assign agent/i).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Engagement mode" })).toBeVisible();
    await page.getByPlaceholder(/Assign agent/i).fill("victor");
    await page.getByRole("option", { name: /@victor/i }).click();
    await expect(page.getByRole("button", { name: /@victor/i }).first()).toBeVisible();
    await expectNoDocumentHorizontalOverflow(page, "issue assignment at 390px");

    await page.goto("/w/forge/agents/victor");
    await expect(page.locator("header", { hasText: "@victor" }).last()).toBeVisible();
    await expectNoDocumentHorizontalOverflow(page, "agent detail at 390px");

    await page.goto("/w/forge/settings/runtimes");
    const runtimeRow = page.getByTestId("runtime-row-e2e-codex-runtime");
    await expect(runtimeRow).toBeVisible();
    await runtimeRow.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/w\/forge\/settings\/runtimes\//);
    await expect(page.getByRole("heading", { name: "Runtime environment" })).toBeVisible();
    await expectNoDocumentHorizontalOverflow(page, "runtime detail at 390px");
  });
});
