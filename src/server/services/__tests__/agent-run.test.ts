import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentRunStatus, EngagementMode, EventKind } from "@prisma/client";
import { finishRun, finishRunsForIssue, openOrTouchRun } from "@/server/services/agent-run";
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
  it("records agent actor attribution on started and completed lifecycle rows", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "ara-a1");
    const issue = await createIssue(fixture);

    const { run } = await prisma.$transaction((tx) =>
      openOrTouchRun(tx, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        actorId: fixture.user.id,
        actorAgentId: agent.id,
      }),
    );

    const started = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_STARTED,
        subjectType: "agent-run",
        subjectId: run.id,
      },
    });
    expect(started.actorId).toBe(fixture.user.id);
    expect(started.actorAgentId).toBe(agent.id);

    await prisma.$transaction((tx) =>
      finishRun(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "COMPLETED",
        summary: "Done.",
        actorId: fixture.user.id,
        actorAgentId: agent.id,
      }),
    );

    const completed = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_COMPLETED,
        subjectType: "agent-run",
        subjectId: run.id,
      },
    });
    expect(completed.actorId).toBe(fixture.user.id);
    expect(completed.actorAgentId).toBe(agent.id);

    const audit = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "AgentRun",
        entityId: run.id,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((row) => row.action)).toEqual(["create", "finish"]);
    expect(audit.every((row) => row.actorAgentId === agent.id)).toBe(true);
  });

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

  it("does not mark another agent's unstarted run completed when an issue reaches done", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARU" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const staleAgent = await createAgent(fixture.workspace.id, "aru-stale");
    const completingAgent = await createAgent(fixture.workspace.id, "aru-finisher");
    const issue = await createIssue(fixture);
    const unstarted = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: staleAgent.id,
        status: AgentRunStatus.ACTIVE,
      },
    });
    const started = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: completingAgent.id,
        status: AgentRunStatus.ACTIVE,
        acknowledgedAt: new Date(),
      },
    });

    await prisma.$transaction((tx) =>
      finishRunsForIssue(tx, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        status: "COMPLETED",
        actorId: fixture.user.id,
        actorAgentId: completingAgent.id,
      }),
    );

    const after = await prisma.agentRun.findMany({
      where: { id: { in: [unstarted.id, started.id] } },
      orderBy: { agentId: "asc" },
    });
    const byId = new Map(after.map((run) => [run.id, run]));
    expect(byId.get(unstarted.id)?.status).toBe(AgentRunStatus.ABANDONED);
    expect(byId.get(unstarted.id)?.summary).toContain("before this run acknowledged");
    expect(byId.get(started.id)?.status).toBe(AgentRunStatus.COMPLETED);

    const staleActivity = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_COMPLETED,
        subjectId: unstarted.id,
      },
    });
    expect(staleActivity.actorId).toBeNull();
    expect(staleActivity.actorAgentId).toBeNull();
    expect(staleActivity.payload).toMatchObject({ finalStatus: "ABANDONED" });
  });
});
