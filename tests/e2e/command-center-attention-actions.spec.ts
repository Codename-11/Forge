import { expect, test } from "@playwright/test";
import {
  ActionRequestKind,
  ActionRequestStatus,
  AgentConnectionKind,
  AgentConnectionLiveness,
  AgentConnectionStatus,
  AgentRunStatus,
  EngagementMode,
  NotificationSeverity,
  PrismaClient,
  WorkSessionParticipantRole,
  WorkSessionSource,
  WorkSessionStatus,
} from "@prisma/client";

const FIXTURE = {
  actionableIssueId: "e2e-axi130-actionable-issue",
  fallbackIssueId: "e2e-axi130-fallback-issue",
  ownerConnectionId: "e2e-axi130-owner-connection",
  candidateConnectionId: "e2e-axi130-candidate-connection",
  workSessionId: "e2e-axi130-work-session",
  candidateRunId: "e2e-axi130-candidate-run",
  actionableRequestId: "e2e-axi130-actionable-request",
  fallbackRequestId: "e2e-axi130-fallback-request",
  secondFallbackRequestId: "e2e-axi131-second-fallback-request",
} as const;

const ACTIONABLE_TITLE = "Choose how the queued delivery connection should join";
const FALLBACK_TITLE = "Review an ask without a registered reply target";

function e2eDatabaseUrl() {
  if (process.env.E2E_MANAGE_STACK === "0") {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when E2E_MANAGE_STACK=0");
    }
    return process.env.DATABASE_URL;
  }

  const url =
    process.env.E2E_DATABASE_URL ??
    "postgresql://forge:forge@localhost:55432/forge_e2e?schema=public";
  if (!url.includes("/forge_e2e")) {
    throw new Error("Refusing to seed attention E2E fixtures outside forge_e2e");
  }
  return url;
}

const prisma = new PrismaClient({
  datasources: { db: { url: e2eDatabaseUrl() } },
});

async function clearFixtures() {
  await prisma.actionRequest.deleteMany({
    where: {
      id: {
        in: [
          FIXTURE.actionableRequestId,
          FIXTURE.fallbackRequestId,
          FIXTURE.secondFallbackRequestId,
        ],
      },
    },
  });
  await prisma.agentRun.deleteMany({ where: { id: FIXTURE.candidateRunId } });
  await prisma.workSessionParticipant.deleteMany({
    where: { workSessionId: FIXTURE.workSessionId },
  });
  await prisma.workSession.deleteMany({ where: { id: FIXTURE.workSessionId } });
  await prisma.issue.deleteMany({
    where: { id: { in: [FIXTURE.actionableIssueId, FIXTURE.fallbackIssueId] } },
  });
  await prisma.agentConnection.deleteMany({
    where: { id: { in: [FIXTURE.ownerConnectionId, FIXTURE.candidateConnectionId] } },
  });
}

test.describe("Command Center attention actions", () => {
  test.beforeAll(async () => {
    await clearFixtures();

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: "forge" },
      select: { id: true },
    });
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: "owner@forge.local" },
      select: { id: true },
    });
    const agent = await prisma.agent.findUniqueOrThrow({
      where: {
        workspaceId_profileKey: { workspaceId: workspace.id, profileKey: "e2ebot" },
      },
      select: { id: true },
    });
    const status = await prisma.status.findFirstOrThrow({
      where: { workspaceId: workspace.id },
      orderBy: { position: "asc" },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.issue.createMany({
        data: [
          {
            id: FIXTURE.actionableIssueId,
            workspaceId: workspace.id,
            number: 130001,
            title: "Typed delivery conflict E2E fixture",
            statusId: status.id,
            authorId: owner.id,
          },
          {
            id: FIXTURE.fallbackIssueId,
            workspaceId: workspace.id,
            number: 130002,
            title: "Safe attention fallback E2E fixture",
            statusId: status.id,
            authorId: owner.id,
          },
        ],
      });
      await tx.agentConnection.createMany({
        data: [
          {
            id: FIXTURE.ownerConnectionId,
            workspaceId: workspace.id,
            agentId: agent.id,
            kind: AgentConnectionKind.MCP_CLIENT,
            livenessModel: AgentConnectionLiveness.LEASE,
            status: AgentConnectionStatus.ACTIVE,
            instanceKey: "axi130-owner",
            displayName: "Codex Desktop primary",
          },
          {
            id: FIXTURE.candidateConnectionId,
            workspaceId: workspace.id,
            agentId: agent.id,
            kind: AgentConnectionKind.MANAGED_RUNTIME,
            livenessModel: AgentConnectionLiveness.HEARTBEAT,
            status: AgentConnectionStatus.ACTIVE,
            instanceKey: "axi130-candidate",
            displayName: "E2E managed runtime",
          },
        ],
      });
      await tx.workSession.create({
        data: {
          id: FIXTURE.workSessionId,
          workspaceId: workspace.id,
          issueId: FIXTURE.actionableIssueId,
          ownerUserId: owner.id,
          ownerAgentId: agent.id,
          ownerConnectionId: FIXTURE.ownerConnectionId,
          source: WorkSessionSource.CODEX_DESKTOP,
          status: WorkSessionStatus.IN_PROGRESS,
          repoFullName: "Codename-11/Forge",
          branch: "codex/e2e-axi130-attention-actions",
        },
      });
      await tx.workSessionParticipant.create({
        data: {
          workspaceId: workspace.id,
          workSessionId: FIXTURE.workSessionId,
          connectionId: FIXTURE.ownerConnectionId,
          agentId: agent.id,
          role: WorkSessionParticipantRole.PRIMARY,
        },
      });
      await tx.agentRun.create({
        data: {
          id: FIXTURE.candidateRunId,
          workspaceId: workspace.id,
          issueId: FIXTURE.actionableIssueId,
          agentId: agent.id,
          connectionId: FIXTURE.candidateConnectionId,
          status: AgentRunStatus.WAITING,
          engagementMode: EngagementMode.EXECUTE,
          currentStep: "Waiting for delivery ownership decision",
        },
      });
      await tx.actionRequest.createMany({
        data: [
          {
            id: FIXTURE.actionableRequestId,
            workspaceId: workspace.id,
            issueId: FIXTURE.actionableIssueId,
            title: ACTIONABLE_TITLE,
            body: "A second connection requested execution while Codex Desktop owns the active delivery session. Choose an explicit collaboration mode; the existing primary remains unchanged until a decision is applied.",
            status: ActionRequestStatus.OPEN,
            severity: NotificationSeverity.WARNING,
            kind: ActionRequestKind.DELIVERY_CONNECTION_CONFLICT,
            requestedByAgentId: agent.id,
            assignedUserId: owner.id,
            sourceType: "agent-run",
            sourceId: FIXTURE.candidateRunId,
            payload: {
              version: 1,
              attemptedMode: "EXECUTE",
              workSessionId: FIXTURE.workSessionId,
              expectedOwnerConnectionId: FIXTURE.ownerConnectionId,
              candidateConnectionId: FIXTURE.candidateConnectionId,
              queuedRunId: FIXTURE.candidateRunId,
            },
          },
          {
            id: FIXTURE.fallbackRequestId,
            workspaceId: workspace.id,
            issueId: FIXTURE.fallbackIssueId,
            title: FALLBACK_TITLE,
            body: "This request intentionally has no registered agent reply target. Forge should direct the operator to the issue instead of inventing an unsafe response action.",
            status: ActionRequestStatus.OPEN,
            severity: NotificationSeverity.INFO,
            kind: ActionRequestKind.FREE_FORM,
            assignedUserId: owner.id,
            sourceType: "e2e-fixture",
            sourceId: FIXTURE.fallbackRequestId,
          },
          {
            id: FIXTURE.secondFallbackRequestId,
            workspaceId: workspace.id,
            issueId: FIXTURE.fallbackIssueId,
            title: "A second decision for the same issue",
            body: "This decision must remain independently visible and dismissible.",
            status: ActionRequestStatus.OPEN,
            severity: NotificationSeverity.WARNING,
            kind: ActionRequestKind.FREE_FORM,
            assignedUserId: owner.id,
            sourceType: "e2e-fixture",
            sourceId: FIXTURE.secondFallbackRequestId,
          },
        ],
      });
    });
  });

  test.afterAll(async () => {
    await clearFixtures();
    await prisma.$disconnect();
  });

  test("renders compact typed actions, expandable evidence, and a safe fallback", async ({
    page,
  }) => {
    await page.goto("/w/forge/command-center");

    const actionableCard = page
      .getByRole("link", { name: ACTIONABLE_TITLE })
      .locator("xpath=ancestor::div[contains(@class, 'bg-card/40')][1]");
    await expect(actionableCard.getByText("ownership conflict", { exact: true })).toBeVisible();

    const actions = actionableCard.getByRole("group", { name: "Available responses" });
    await expect(actions.getByRole("button", { name: "Continue as contributor" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Join as reviewer" })).toBeVisible();
    await expect(actions.getByRole("button", { name: "Hand off primary" })).toHaveCount(0);

    await actions.getByRole("button", { name: "More responses" }).click();
    await expect(page.getByRole("menuitem", { name: /Hand off primary/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Cancel new dispatch/ })).toBeVisible();
    await page.keyboard.press("Escape");

    const details = actionableCard.getByRole("button", { name: /request details/ });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(actionableCard.getByText("Requested mode", { exact: true })).toBeVisible();
    await expect(actionableCard.getByText("E2E managed runtime", { exact: true })).toBeVisible();
    await actionableCard.getByText("Technical details", { exact: true }).click();
    const queuedRunEvidence = actionableCard.getByText(FIXTURE.candidateRunId, { exact: true });
    await expect(queuedRunEvidence).toHaveCount(2);
    await expect(queuedRunEvidence.first()).toBeVisible();

    const fallbackCard = page
      .getByRole("link", { name: FALLBACK_TITLE })
      .locator("xpath=ancestor::div[contains(@class, 'bg-card/40')][1]");
    await expect(fallbackCard.getByRole("link", { name: "Open issue" })).toBeVisible();
    await expect(fallbackCard.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(fallbackCard.getByRole("button", { name: "Respond" })).toHaveCount(0);
    await expect(fallbackCard.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expect(fallbackCard.getByRole("button", { name: "Decline" })).toHaveCount(0);

    const secondFallbackCard = page
      .getByRole("link", { name: "A second decision for the same issue" })
      .locator("xpath=ancestor::div[contains(@class, 'bg-card/40')][1]");
    await expect(secondFallbackCard).toBeVisible();
    await expect(secondFallbackCard.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });
});
