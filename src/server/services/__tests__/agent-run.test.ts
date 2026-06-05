import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentRunStatus, EngagementMode } from "@prisma/client";
import { openOrTouchRun } from "@/server/services/agent-run";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function createAgent(workspaceId: string, profileKey: string): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: profileKey,
      profileKey,
      status: "ONLINE",
    },
    select: { id: true },
  });
}

describe("agent-run lifecycle", () => {
  it("touching an existing run can restamp engagement mode and resume WAITING", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARM" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arm-a1");
    const issue = await createIssue(fixture);
    const existing = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        engagementMode: EngagementMode.REVIEW,
        currentStep: "blocked",
      },
    });

    const result = await prisma.$transaction((tx) =>
      openOrTouchRun(tx, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        assignmentEventId: "event-restamp",
        currentStep: "starting run",
        engagementMode: EngagementMode.EXECUTE,
      }),
    );

    expect(result.isNew).toBe(false);
    expect(result.run.id).toBe(existing.id);
    expect(result.run.status).toBe(AgentRunStatus.ACTIVE);
    expect(result.run.engagementMode).toBe(EngagementMode.EXECUTE);
    expect(result.run.currentStep).toBe("starting run");
    expect(result.run.assignmentEventId).toBe("event-restamp");
  });
});
