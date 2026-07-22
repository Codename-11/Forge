import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { AgentRunStatus, EngagementMode, EventKind, RuntimeKind } from "@prisma/client";
import {
  abandonRunsForAgentReassignment,
  appendRunEvent,
  finishRun,
  finishRunsForIssue,
  openOrTouchRun,
} from "@/server/services/agent-run";
import {
  buildContext,
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { agentRunRouter } from "@/server/routers/agent-run";
import { captureRunApproval, resolveRunApproval } from "@/server/services/run-approval-lifecycle";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

    const finalComment = await prisma.comment.findFirstOrThrow({
      where: {
        issueId: issue.id,
        authoringAgentId: agent.id,
        kind: "BODY",
        body: "Done.",
      },
    });
    const completedRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(completedRun.completionMeta).toMatchObject({
      completionCommentId: finalComment.id,
    });

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

  it("creates one final comment when completion attempts race", async () => {
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
      },
    });
    const complete = () =>
      prisma.$transaction((tx) =>
        finishRun(tx, {
          runId: run.id,
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          status: "COMPLETED",
          summary: "One durable result.",
          actorAgentId: agent.id,
        }),
      );

    await Promise.all([complete(), complete()]);

    expect(
      await prisma.comment.count({
        where: { issueId: issue.id, authoringAgentId: agent.id, body: "One durable result." },
      }),
    ).toBe(1);
    expect(await prisma.agentRunEvent.count({ where: { runId: run.id, kind: "COMPLETED" } })).toBe(
      1,
    );
    expect(
      await prisma.activityEvent.count({
        where: { subjectType: "agent-run", subjectId: run.id, kind: EventKind.AGENT_RUN_COMPLETED },
      }),
    ).toBe(1);
  });

  it("posts one stalled terminal comment without opening a replacement run", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "ars-a1");
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    await prisma.issueWatcher.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        wakeOnActivity: true,
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
      },
    });

    await Promise.all([
      prisma.$transaction((tx) =>
        finishRun(tx, {
          runId: run.id,
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          status: "STALLED",
          summary: "Provider contract ended unexpectedly.",
        }),
      ),
      prisma.$transaction((tx) =>
        finishRun(tx, {
          runId: run.id,
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          status: "STALLED",
          summary: "Provider contract ended unexpectedly.",
        }),
      ),
    ]);

    const runs = await prisma.agentRun.findMany({ where: { issueId: issue.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(AgentRunStatus.STALLED);
    expect(
      await prisma.comment.count({
        where: {
          issueId: issue.id,
          authoringAgentId: agent.id,
          body: { contains: "[dispatch · run stalled]" },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.webhookDelivery.count({
        where: { event: { subjectType: "issue", subjectId: issue.id } },
      }),
    ).toBe(0);
  });

  it("keeps an incidental touch parked until resume authority is explicit", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arp-a1");
    const issue = await createIssue(fixture);
    const pausedAt = new Date(Date.now() - 60_000);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        lastEventAt: pausedAt,
      },
    });

    const parked = await prisma.$transaction((tx) =>
      openOrTouchRun(tx, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        triggerEventId: "informational-touch",
        triggerKind: EventKind.COMMENT_CREATED,
      }),
    );
    expect(parked.run.status).toBe(AgentRunStatus.WAITING);
    expect(parked.run.lastEventAt).toEqual(pausedAt);

    const resumed = await prisma.$transaction((tx) =>
      openOrTouchRun(tx, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        resumeWaiting: true,
      }),
    );
    expect(resumed.run.id).toBe(run.id);
    expect(resumed.run.status).toBe(AgentRunStatus.ACTIVE);
    expect(resumed.run.lastEventAt.getTime()).toBeGreaterThan(pausedAt.getTime());
  });

  it("a fresh assignment touch re-stamps mode + source and resumes WAITING (Phase 2)", async () => {
    // A genuine AGENT_ASSIGNED (fresh assignmentEventId) is an authoritative
    // (re)dispatch: the resolved mode the inbox passes in wins. Sticky-mode
    // preservation now lives in the inbox's activeRunMode waterfall tier, which
    // runs *before* this call — so openOrTouchRun honors what it's given.
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
        engagementSource: "payload",
      }),
    );

    expect(result.isNew).toBe(false);
    expect(result.run.id).toBe(existing.id);
    expect(result.run.status).toBe(AgentRunStatus.ACTIVE);
    expect(result.run.engagementMode).toBe(EngagementMode.EXECUTE);
    expect(result.run.engagementSource).toBe("PAYLOAD");
    expect(result.run.currentStep).toBe("starting run");
    expect(result.run.assignmentEventId).toBe("event-restamp");
  });

  it("an incidental touch (no fresh assignment) preserves the sticky mode", async () => {
    // A comment wake / MCP write touches the run with assignmentEventId=null, so
    // it must NOT clobber a deliberately-set mode — the sticky guarantee the
    // inbox's activeRunMode tier depends on.
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARMI" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "armi-a1");
    const issue = await createIssue(fixture);
    const existing = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        engagementMode: EngagementMode.REVIEW,
        engagementSource: "POLICY_FIXED",
        currentStep: "reviewing",
      },
    });

    const result = await prisma.$transaction((tx) =>
      openOrTouchRun(tx, {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        // no assignmentEventId — an incidental wake
        currentStep: "still going",
        engagementMode: EngagementMode.EXECUTE,
        engagementSource: "payload",
      }),
    );

    expect(result.run.id).toBe(existing.id);
    expect(result.run.engagementMode).toBe(EngagementMode.REVIEW);
    expect(result.run.engagementSource).toBe("POLICY_FIXED");
    expect(result.run.currentStep).toBe("still going");
  });

  it("finishRun closes WAITING runs", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARW" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arw-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        currentStep: "waiting on operator",
      },
    });

    await prisma.$transaction((tx) =>
      finishRun(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ABANDONED",
        summary: "Operator stopped the waiting run.",
        actorId: fixture.user.id,
      }),
    );

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe(AgentRunStatus.ABANDONED);
    expect(after.finishedAt).not.toBeNull();
    expect(after.currentStep).toBeNull();

    const eventCount = await prisma.agentRunEvent.count({ where: { runId: run.id } });
    await prisma.$transaction((tx) =>
      appendRunEvent(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        kind: "STEP",
        currentStep: "late thinking",
        payload: { thinking: "buffered after completion" },
      }),
    );
    const afterLateEvent = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterLateEvent.currentStep).toBeNull();
    expect(await prisma.agentRunEvent.count({ where: { runId: run.id } })).toBe(eventCount);
  });

  it("keeps the operator-facing waiting reason when buffered progress arrives", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arp-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        currentStep: "Waiting for the operator to choose a release window",
      },
    });

    await prisma.$transaction((tx) =>
      appendRunEvent(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        kind: "STEP",
        currentStep: "thinking",
        payload: { thinking: "Buffered progress detail after the run parked." },
      }),
    );

    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({
      currentStep: "Waiting for the operator to choose a release window",
    });
    await expect(prisma.agentRunEvent.count({ where: { runId: run.id } })).resolves.toBe(1);
  });

  it("records one actionable approval lifecycle across competing producers", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "ara-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
      },
    });
    const approval = {
      command: "rm -rf /tmp/checkout",
      description: "delete in root path",
      choices: ["once", "session", "deny"],
    };

    const captured = await prisma.$transaction((tx) =>
      captureRunApproval(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        approval,
        source: "subscription",
      }),
    );
    const duplicateCapture = await prisma.$transaction((tx) =>
      captureRunApproval(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        approval: null,
        source: "poll",
      }),
    );
    expect(captured).toBe(true);
    expect(duplicateCapture).toBe(false);

    const blocked = await prisma.agentRunEvent.findMany({
      where: { runId: run.id, kind: "BLOCKED" },
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.payload).toMatchObject({
      issueId: issue.id,
      reason: "runtime-approval-required",
      approval,
    });
    expect(
      await prisma.activityEvent.count({
        where: {
          workspaceId: fixture.workspace.id,
          subjectId: run.id,
          kind: EventKind.AGENT_RUN_BLOCKED,
        },
      }),
    ).toBe(1);
    expect(
      (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).pendingApproval,
    ).toMatchObject(approval);

    const pollFirstRun = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
      },
    });
    await prisma.$transaction((tx) =>
      captureRunApproval(tx, {
        runId: pollFirstRun.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        approval: null,
        source: "poll",
      }),
    );
    await prisma.$transaction((tx) =>
      captureRunApproval(tx, {
        runId: pollFirstRun.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        approval,
        source: "subscription",
      }),
    );
    const pollFirstAfter = await prisma.agentRun.findUniqueOrThrow({
      where: { id: pollFirstRun.id },
      include: { events: true },
    });
    expect(pollFirstAfter.pendingApproval).toMatchObject(approval);
    expect(pollFirstAfter.events.filter((event) => event.kind === "BLOCKED")).toHaveLength(1);

    const resolved = await prisma.$transaction((tx) =>
      resolveRunApproval(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        source: "operator",
        decision: "session",
        currentStep: "approved (session) · resuming",
      }),
    );
    const duplicateResolution = await prisma.$transaction((tx) =>
      resolveRunApproval(tx, {
        runId: run.id,
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        source: "subscription",
        decision: "session",
        currentStep: "approval resolved · resuming",
      }),
    );
    expect(resolved).toBe(true);
    expect(duplicateResolution).toBe(false);

    const after = await prisma.agentRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    expect(after.awaitingApprovalAt).toBeNull();
    expect(after.pendingApproval).toBeNull();
    expect(after.events.filter((event) => event.kind === "STEP")).toHaveLength(1);
    expect(after.events.at(-1)?.payload).toMatchObject({
      issueId: issue.id,
      approvalResolved: true,
      source: "operator",
      decision: "session",
    });
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

  it("restartWithMode abandons the current run and opens a new run with the requested mode", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARR" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arr-a1");
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        engagementMode: EngagementMode.REVIEW,
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const result = await caller.restartWithMode({
      runId: run.id,
      mode: EngagementMode.EXECUTE,
    });
    expect(result.restarted).toBe(true);

    const runs = await prisma.agentRun.findMany({
      where: { issueId: issue.id, agentId: agent.id },
      orderBy: { startedAt: "asc" },
    });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.id).toBe(run.id);
    expect(runs[0]?.status).toBe(AgentRunStatus.ABANDONED);
    expect(runs[0]?.summary).toContain("restart as EXECUTE");
    expect(runs[1]?.status).toBe(AgentRunStatus.ACTIVE);
    expect(runs[1]?.engagementMode).toBe(EngagementMode.EXECUTE);
    expect(runs[1]?.assignmentEventId).not.toBeNull();
  });

  it("retires and restarts an approval whose provider run expired", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Hermes expired run",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "http://hermes.invalid/v1",
      },
    });
    const agent = await createAgent(fixture.workspace.id, "are-a1");
    await prisma.agent.update({
      where: { id: agent.id },
      data: { provider: "HERMES", runtimeId: runtime.id },
    });
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        engagementMode: EngagementMode.RESEARCH,
        externalRunId: "run_expired",
        awaitingApprovalAt: new Date(),
        pendingApproval: { command: "git clone example", choices: ["session", "deny"] },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "Run not found: run_expired", code: "run_not_found" } },
          { status: 404 },
        ),
      ),
    );

    const caller = agentRunRouter.createCaller(await buildContext(fixture));
    const result = await caller.respondApproval({
      runId: run.id,
      decision: "approve",
      scope: "session",
    });
    expect(result).toMatchObject({ decision: "expired", restarted: true });

    const expired = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(expired.status).toBe(AgentRunStatus.STALLED);
    expect(expired.awaitingApprovalAt).toBeNull();
    expect(expired.pendingApproval).toBeNull();
    expect(expired.summary).toMatch(/started a fresh run/i);

    const updatedIssue = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(updatedIssue.assignedAgentId).toBe(agent.id);
    expect(updatedIssue.dispatchReason).toMatchObject({
      mode: "APPROVAL_EXPIRED_RESTART",
      restartedFromRunId: run.id,
    });
    const restart = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_ASSIGNED,
        subjectId: issue.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(restart.payload).toMatchObject({
      agentId: agent.id,
      restartedFromRunId: run.id,
      engagementMode: EngagementMode.RESEARCH,
    });
    const fresh = await prisma.agentRun.findMany({
      where: { issueId: issue.id, agentId: agent.id },
      orderBy: { startedAt: "asc" },
    });
    expect(fresh).toHaveLength(2);
    expect(fresh[1]?.status).toBe(AgentRunStatus.ACTIVE);
    expect(fresh[1]?.engagementMode).toBe(EngagementMode.RESEARCH);
    expect(fresh[1]?.assignmentEventId).toBe(restart.id);
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
    const waiting = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: staleAgent.id,
        status: AgentRunStatus.WAITING,
        acknowledgedAt: new Date(),
        currentStep: "waiting",
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
      where: { id: { in: [unstarted.id, started.id, waiting.id] } },
      orderBy: { agentId: "asc" },
    });
    const byId = new Map(after.map((run) => [run.id, run]));
    expect(byId.get(unstarted.id)?.status).toBe(AgentRunStatus.ABANDONED);
    expect(byId.get(unstarted.id)?.summary).toContain("before this run acknowledged");
    expect(byId.get(started.id)?.status).toBe(AgentRunStatus.COMPLETED);
    expect(byId.get(waiting.id)?.status).toBe(AgentRunStatus.COMPLETED);

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

  it("recovery abandons stale active runs and clears them from operational queues", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARX" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arx-a1");
    const issue = await createIssue(fixture);
    const old = new Date(Date.now() - 20 * 60_000);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.ACTIVE,
        lastEventAt: old,
        currentStep: "wake sent",
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const recovery = await caller.recovery({ limit: 10 });
    const item = recovery.items.find((row) => row.id === run.id);
    expect(item?.reason).toBe("active-stale");
    expect(item?.recommendedAction).toBe("ABANDON");
    expect(recovery.counts.activeStale).toBeGreaterThanOrEqual(1);

    const result = await caller.recoverMany({ runIds: [run.id], action: "ABANDON" });
    expect(result).toMatchObject({ ok: true, action: "ABANDON", changed: 1, runIds: [run.id] });

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe(AgentRunStatus.ABANDONED);
    expect(after.finishedAt).not.toBeNull();
    expect(after.clearedAt).not.toBeNull();
    expect(after.clearedById).toBe(fixture.user.id);

    const empty = await caller.recovery({ limit: 10 });
    expect(empty.items.map((row) => row.id)).not.toContain(run.id);
  });

  it("recovery reconciles protocol-failed completed runs without rewriting completion history", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "arp-a1");
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { artifactRequired: true },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.COMPLETED,
        finishedAt: new Date(),
        summary: "Done.",
        producedArtifactIds: [],
        engagementMode: EngagementMode.EXECUTE,
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const recovery = await caller.recovery({ limit: 10 });
    const item = recovery.items.find((row) => row.id === run.id);
    expect(item?.reason).toBe("protocol-failed");
    expect(item?.detail).toMatch(/requires at least one produced artifact/i);

    const result = await caller.recoverMany({
      runIds: [run.id],
      action: "RECONCILE",
      summary: "Reviewed historical completion.",
    });
    expect(result.changed).toBe(1);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe(AgentRunStatus.COMPLETED);
    expect(after.clearedAt).not.toBeNull();
    expect(after.completionMeta).toMatchObject({
      protocolReconciledById: fixture.user.id,
      protocolReconciledReason: "Reviewed historical completion.",
    });
    const reconciledEvent = await prisma.agentRunEvent.findFirstOrThrow({
      where: { runId: run.id, kind: "RECONCILED" },
    });
    expect(reconciledEvent.payload).toBeTruthy();
  });

  it("runtimeCompliance reports declared tools, host enforcement, and recovery signals", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Hermes prompt-only",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "http://127.0.0.1:8642/v1",
        config: { toolCapabilities: [] },
      },
    });
    const agent = await createAgent(fixture.workspace.id, "ars-a1");
    await prisma.agent.update({
      where: { id: agent.id },
      data: { runtimeId: runtime.id },
    });
    const issue = await createIssue(fixture);
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.STALLED,
        finishedAt: new Date(),
        summary: "No runtime output.",
      },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const scorecard = await caller.runtimeCompliance();
    const card = scorecard.agents.find((row) => row.agentId === agent.id);
    expect(card?.hasRepoTools).toBe(false);
    expect(card?.hostToolPolicyEnforced).toBe(false);
    expect(card?.terminalFailures).toBe(1);
    expect(card?.signals.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(["no-repo-tools", "prompt-only-tools", "terminal-failures"]),
    );
  });

  it("runtimeCompliance reports stale runtime config that no longer validates", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Hermes stale config",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "http://127.0.0.1:8642/v1",
        config: { toolCapabilities: ["shell"] },
      },
    });
    const agent = await createAgent(fixture.workspace.id, "arc-a1");
    await prisma.agent.update({
      where: { id: agent.id },
      data: { runtimeId: runtime.id },
    });
    const caller = agentRunRouter.createCaller(await buildContext(fixture));

    const scorecard = await caller.runtimeCompliance();
    const card = scorecard.agents.find((row) => row.agentId === agent.id);
    expect(card?.signals.map((signal) => signal.code)).toEqual(
      expect.arrayContaining(["config-mismatch"]),
    );
    expect(card?.signals.find((signal) => signal.code === "config-mismatch")?.detail).toMatch(
      /current Hermes adapter schema/i,
    );
  });

  it("abandons only the previous assignee run on reassignment", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARR" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const oldAgent = await createAgent(fixture.workspace.id, "arr-old");
    const newAgent = await createAgent(fixture.workspace.id, "arr-new");
    const issue = await createIssue(fixture);
    const oldRun = await openOrTouchRun(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      agentId: oldAgent.id,
      currentStep: "old agent working",
    });
    const newRun = await openOrTouchRun(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      agentId: newAgent.id,
      currentStep: "new agent working",
    });

    const count = await abandonRunsForAgentReassignment(prisma, {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      agentId: oldAgent.id,
      actorId: fixture.user.id,
    });

    expect(count).toBe(1);
    const oldAfter = await prisma.agentRun.findUniqueOrThrow({ where: { id: oldRun.run.id } });
    const newAfter = await prisma.agentRun.findUniqueOrThrow({ where: { id: newRun.run.id } });
    expect(oldAfter.status).toBe(AgentRunStatus.ABANDONED);
    expect(oldAfter.finishedAt).not.toBeNull();
    expect(newAfter.status).toBe(AgentRunStatus.ACTIVE);
  });
});
