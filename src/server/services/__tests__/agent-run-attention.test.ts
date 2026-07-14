import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentRunStatus } from "@prisma/client";
import { agentRunRouter } from "@/server/routers/agent-run";
import { listRunRecoveryItems } from "@/server/services/agent-run-recovery";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function createAgent(workspaceId: string, suffix: string) {
  return getPrisma().agent.create({
    data: {
      workspaceId,
      name: `Agent ${suffix}`,
      profileKey: `attention-${suffix}-${Date.now()}`,
    },
  });
}

describe("agent-run operator attention", () => {
  it("keeps a patient WAITING run out of generic stale recovery", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RW" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Waiting on a user answer" });
    const agent = await createAgent(fixture.workspace.id, "patient");
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        currentStep: "Waiting for the user to provide the full rollout requirements.",
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentRun" SET "lastEventAt" = $1 WHERE "id" = $2`,
      new Date(Date.now() - 60 * 60_000),
      run.id,
    );

    const recovery = await listRunRecoveryItems(prisma, {
      workspaceId: fixture.workspace.id,
      limit: 20,
    });

    expect(recovery.items.map((item) => item.id)).not.toContain(run.id);
    expect(recovery.counts.activeStale).toBe(0);
  });

  it("does not misclassify an old approval pause as generic stale recovery", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Approval is the recovery action" });
    const agent = await createAgent(fixture.workspace.id, "approval");
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        awaitingApprovalAt: new Date(Date.now() - 30 * 60_000),
        pendingApproval: { command: "pnpm install" },
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentRun" SET "lastEventAt" = $1 WHERE "id" = $2`,
      new Date(Date.now() - 60 * 60_000),
      run.id,
    );

    const recovery = await listRunRecoveryItems(prisma, {
      workspaceId: fixture.workspace.id,
      limit: 20,
    });

    expect(recovery.items.map((item) => item.id)).not.toContain(run.id);
    expect(recovery.counts.activeStale).toBe(0);
  });

  it("returns an approval-first run on an unassigned issue", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RI" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Unassigned but blocked" });
    const approvalAgent = await createAgent(fixture.workspace.id, "blocked");
    const activeAgent = await createAgent(fixture.workspace.id, "active");
    const approvalRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: approvalAgent.id,
        status: AgentRunStatus.ACTIVE,
        currentStep: "needs temporary permission",
        lastEventAt: new Date(Date.now() - 60_000),
        awaitingApprovalAt: new Date(Date.now() - 60_000),
        pendingApproval: { command: "git push" },
      },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: activeAgent.id,
        status: AgentRunStatus.ACTIVE,
        currentStep: "newer ordinary work",
        lastEventAt: new Date(),
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const visible = await caller.activeForIssue({ issueId: issue.id });

    expect(visible).toMatchObject({
      id: approvalRun.id,
      awaitingApprovalAt: expect.any(Date),
      pendingApproval: { command: "git push" },
      agent: { id: approvalAgent.id },
    });
  });
});
