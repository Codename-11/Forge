import { expect, test } from "@playwright/test";
import { PrismaClient, RelationKind } from "@prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

async function blockerFixture() {
  const [blocked, blocker] = await Promise.all([
    prisma.issue.findFirstOrThrow({
      where: { workspace: { slug: "forge" }, number: 22 },
      select: { id: true, title: true },
    }),
    prisma.issue.findFirstOrThrow({
      where: { workspace: { slug: "forge" }, number: 18 },
      select: { id: true, title: true },
    }),
  ]);
  return { blocked, blocker };
}

async function clearFixtureRelations() {
  const { blocked, blocker } = await blockerFixture();
  await prisma.issueRelation.deleteMany({
    where: {
      OR: [
        {
          fromIssueId: blocked.id,
          toIssueId: blocker.id,
          kind: RelationKind.BLOCKED_BY,
        },
        {
          fromIssueId: blocker.id,
          toIssueId: blocked.id,
          kind: RelationKind.BLOCKS,
        },
      ],
    },
  });
}

test.beforeEach(async () => {
  await clearFixtureRelations();
});

test.afterEach(async () => {
  await clearFixtureRelations();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("sets, surfaces, and removes a native dependency blocker", async ({ page }) => {
  const { blocked } = await blockerFixture();
  await page.goto(`/w/forge/issues/${blocked.id}`);

  await page.getByRole("button", { name: "Set blocker", exact: true }).click();
  await page.getByLabel("Search issues to use as a blocker").fill("FRG-18");
  await page.getByText("FRG-18", { exact: true }).click();

  const banner = page.getByTestId("issue-blocker-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Blocked by 1 open issue");
  await expect(banner).toContainText("Workspace switcher onboarding tour");
  await expect(page.getByRole("button", { name: "Blocked · 1" })).toBeVisible();

  await page.goto("/w/forge/dashboard");
  await page.getByRole("tab", { name: /Blocked/ }).click();
  await expect(page.getByRole("tabpanel")).toContainText(blocked.title);
  await expect(page.getByTestId("dashboard-work-lanes")).not.toContainText(blocked.title);

  await page.goto(`/w/forge/issues/${blocked.id}`);
  await page.getByRole("button", { name: "Remove blocker FRG-18" }).click();
  await expect(page.getByTestId("issue-blocker-banner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set blocker", exact: true })).toBeVisible();
});
