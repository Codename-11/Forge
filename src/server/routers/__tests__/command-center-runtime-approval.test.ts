import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentRunStatus } from "@prisma/client";
import { commandCenterRouter } from "@/server/routers/command-center";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("commandCenterRouter — runtime approvals", () => {
  it("counts a paused runtime once as a decision and not as an ordinary active run", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "CC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Permission-paused issue" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `victor-${Date.now()}`,
      },
    });
    const approvalRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        currentStep: "waiting for permission",
        awaitingApprovalAt: new Date(),
        pendingApproval: {
          command: "git fetch origin",
          description: "Network access is required.",
        },
      },
    });
    const ordinaryRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        currentStep: "reading source",
      },
    });
    const caller = commandCenterRouter.createCaller(await buildContext(fixture));

    const summary = await caller.summary({ dueWindowDays: 7, limit: 20 });

    expect(summary.runtimeApprovals.map((run) => run.id)).toEqual([approvalRun.id]);
    expect(summary.runtimeApprovals[0]?.pendingApproval).toMatchObject({
      command: "git fetch origin",
      description: "Network access is required.",
    });
    expect(summary.activeRuns.map((run) => run.id)).toContain(ordinaryRun.id);
    expect(summary.activeRuns.map((run) => run.id)).not.toContain(approvalRun.id);
    expect(summary.counts.runtimeApprovals).toBe(1);
    expect(summary.counts.activeRuns).toBe(1);
    expect(summary.stalledRuns.map((run) => run.id)).not.toContain(approvalRun.id);

    const decisions = await caller.decisionsCount();
    expect(decisions).toMatchObject({
      actionRequests: 0,
      reviewGates: 0,
      runtimeApprovals: 1,
      total: 1,
    });
  });
});
