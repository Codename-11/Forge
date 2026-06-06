import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentRunStatus, EngagementMode, EventKind } from "@prisma/client";
import { appendRunEvent, finishRun, finishRunsForIssue, openOrTouchRun } from "@/server/services/agent-run";
import {
  buildContext,
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { agentRunRouter } from "@/server/routers/agent-run";

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

  it("touching an existing run preserves engagement mode and resumes WAITING", async () => {
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
    expect(result.run.engagementMode).toBe(EngagementMode.REVIEW);
    expect(result.run.currentStep).toBe("starting run");
    expect(result.run.assignmentEventId).toBe("event-restamp");
  });

  it("rejects in-place engagement mode changes for active runs", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARL" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arl-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        engagementMode: EngagementMode.RESEARCH,
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    await expect(
      caller.setEngagementMode({ runId: run.id, mode: EngagementMode.EXECUTE }),
    ).rejects.toThrow(/fixed when a run starts/i);

    const unchanged = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(unchanged.engagementMode).toBe(EngagementMode.RESEARCH);
  });

  it("marks output started on the first substantive run event", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARO" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "aro-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        acknowledgedAt: new Date(),
      },
    });

    await prisma.$transaction((tx) =>
      appendRunEvent(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        kind: "DISPATCH_STARTED",
      }),
    );
    const afterDispatch = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterDispatch.outputStartedAt).toBeNull();

    await prisma.$transaction((tx) =>
      appendRunEvent(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        kind: "STATUS",
        currentStep: "starting work",
      }),
    );
    const afterStatus = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterStatus.outputStartedAt).not.toBeNull();
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

  it("clears terminal failures from operational run lists without deleting history", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arc-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.STALLED,
        finishedAt: new Date(),
        summary: "No runtime activity.",
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const before = await caller.list({ status: [AgentRunStatus.STALLED], limit: 10 });
    expect(before.map((row) => row.id)).toContain(run.id);

    const result = await caller.clearMany({ runIds: [run.id] });
    expect(result).toMatchObject({ ok: true, cleared: 1, runIds: [run.id] });

    const hidden = await caller.list({ status: [AgentRunStatus.STALLED], limit: 10 });
    expect(hidden.map((row) => row.id)).not.toContain(run.id);

    const withCleared = await caller.list({
      status: [AgentRunStatus.STALLED],
      includeCleared: true,
      limit: 10,
    });
    expect(withCleared.map((row) => row.id)).toContain(run.id);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.clearedAt).toBeTruthy();
    expect(after.clearedById).toBe(fixture.user.id);
    expect(after.status).toBe(AgentRunStatus.STALLED);

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_CLEARED,
        subjectId: run.id,
      },
    });
    expect(event.payload).toMatchObject({
      runId: run.id,
      issueId: issue.id,
      agentId: agent.id,
      status: AgentRunStatus.STALLED,
    });
  });
});
