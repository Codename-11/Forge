import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import {
  AgentProvider,
  AgentRunStatus,
  EngagementMode,
  EventKind,
  RuntimeKind,
  RunEngine,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  dispatchTriggerContext,
  ingestRunsDispatch,
} from "@/server/services/dispatch/run-dispatcher";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

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

describe("runs dispatcher", () => {
  it("preserves the decompose prompt for runtime-backed planners", () => {
    const context = dispatchTriggerContext(EventKind.ISSUE_UPDATED, {
      action: "decompose",
      prompt: "Call plans.addSteps with a complete dependency graph.",
    });
    expect(context).toContain("Planning assignment");
    expect(context).toContain("plans.addSteps");
  });

  it("retires a WAITING approval after the provider swept its run", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "RDE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerId: fixture.user.id,
        name: "Hermes TTL test",
        kind: RuntimeKind.REMOTE_HTTP,
        adapterKey: "hermes",
        endpoint: "http://hermes.invalid/v1",
        providersAvailable: [AgentProvider.HERMES],
      },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "expired runner",
        profileKey: "expired-runner",
        provider: AgentProvider.HERMES,
        runEngine: RunEngine.RUNS,
        runtimeId: runtime.id,
        status: "ONLINE",
      },
    });
    const issue = await createIssue(fixture, { title: "expired approval" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        externalRunId: "run_expired_poll",
        awaitingApprovalAt: new Date(),
        pendingApproval: { command: "git clone example", choices: ["session", "deny"] },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "Run not found: run_expired_poll", code: "run_not_found" } },
          { status: 404 },
        ),
      ),
    );

    const tick = await ingestRunsDispatch();
    expect(tick.polled).toBeGreaterThanOrEqual(1);
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe(AgentRunStatus.STALLED);
    expect(after.awaitingApprovalAt).toBeNull();
    expect(after.pendingApproval).toBeNull();
    expect(after.summary).toMatch(/provider no longer recognizes this run/i);
  });

  it("starts the provider run when the durable inbox already precreated AgentRun", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDS" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "runner",
          profileKey: "runner",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "dispatch me" });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { assignedAgentId: agent.id },
      });

      await prisma.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: fixture.workspace.id,
          actorId: fixture.user.id,
          entity: "Issue",
          entityId: issue.id,
          action: "assign-agent",
          eventKind: EventKind.AGENT_ASSIGNED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            agentId: agent.id,
            previousAgentId: null,
            engagementMode: EngagementMode.REVIEW,
          },
        });
      });

      const precreated = await prisma.agentRun.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
        },
      });
      expect(precreated.externalRunId).toBeNull();
      expect(precreated.engagementMode).toBe(EngagementMode.REVIEW);

      const tick = await ingestRunsDispatch();
      expect(tick.started).toBeGreaterThanOrEqual(1);

      const after = await prisma.agentRun.findUniqueOrThrow({
        where: { id: precreated.id },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      expect(after.externalRunId).toMatch(/^mock-/);
      expect(after.engagementMode).toBe(EngagementMode.REVIEW);
      expect(after.runtimePolicy).toMatchObject({
        contractVersion: expect.stringMatching(/^2026-/),
        engagementMode: "REVIEW",
      });
      expect(after.events.some((e) => e.kind === "DISPATCH_STARTED")).toBe(true);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });

  it("does not bypass plan readiness for a deferred assignment event", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDD" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock deferred runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "scheduled runner",
          profileKey: "scheduled-runner",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "wait for plan dependency" });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { assignedAgentId: agent.id },
      });
      const assignment = await prisma.activityEvent.create({
        data: {
          workspaceId: fixture.workspace.id,
          kind: EventKind.AGENT_ASSIGNED,
          actorId: fixture.user.id,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            agentId: agent.id,
            planId: "plan-not-ready",
            planStepId: "step-not-ready",
            orchestrationDeferred: true,
          },
        },
      });

      await ingestRunsDispatch();

      expect(
        await prisma.agentRun.count({
          where: { assignmentEventId: assignment.id },
        }),
      ).toBe(0);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });

  it("starts the provider run for comment-created AgentRuns without legacy webhook dispatch", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDC" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "comment runner",
          profileKey: "comment-runner",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
          webhookUrl: "https://legacy.example.test/dispatch",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "comment wake" });

      await prisma.$transaction(async (tx) => {
        await recordChange(tx, {
          workspaceId: fixture.workspace.id,
          actorId: fixture.user.id,
          entity: "Comment",
          entityId: "comment-runner-comment",
          action: "create",
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            mentions: { agentIds: [agent.id] },
          },
        });
      });

      const precreated = await prisma.agentRun.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
        },
      });
      expect(precreated.triggerKind).toBe(EventKind.COMMENT_CREATED);
      expect(precreated.externalRunId).toBeNull();

      const legacyDeliveries = await prisma.webhookDelivery.count({
        where: { eventId: precreated.triggerEventId! },
      });
      expect(legacyDeliveries).toBe(0);

      const tick = await ingestRunsDispatch();
      expect(tick.started).toBeGreaterThanOrEqual(1);

      const after = await prisma.agentRun.findUniqueOrThrow({
        where: { id: precreated.id },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      expect(after.externalRunId).toMatch(/^mock-/);
      expect(after.events.some((e) => e.kind === "DISPATCH_STARTED")).toBe(true);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });

  it("resumes a WAITING run when an operator reply lands after it paused", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDW" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "waiter",
          profileKey: "waiting-runner",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "blocked then replied" });
      // A run that paused 5 minutes ago via runs.setWaiting: WAITING, has an
      // externalRunId from the prior turn, nobody re-invoking it.
      const pausedAt = new Date(Date.now() - 5 * 60_000);
      const run = await prisma.agentRun.create({
        data: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          status: "WAITING",
          externalRunId: "mock-waiting-1",
          currentStep: "blocked on a question",
          lastEventAt: pausedAt,
        },
      });
      // Operator reply that lands AFTER the run paused.
      await prisma.comment.create({
        data: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          authorId: fixture.user.id,
          body: "go ahead, skip the DB-backed tests",
        },
      });

      const tick = await ingestRunsDispatch();
      expect(tick.resumed).toBeGreaterThanOrEqual(1);

      // The WAITING run was re-dispatched: a fresh provider run id (not the
      // paused one) and a DISPATCH_STARTED event tagged resumedFromWaiting.
      // (Final status is left to the poll — the mock connector completes
      // instantly without a runs.complete contract, so it's not asserted.)
      const after = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      expect(after.externalRunId).toMatch(/^mock-/);
      expect(after.externalRunId).not.toBe("mock-waiting-1");
      expect(
        after.events.some(
          (e) =>
            e.kind === "DISPATCH_STARTED" &&
            (e.payload as { resumedFromWaiting?: boolean } | null)?.resumedFromWaiting === true,
        ),
      ).toBe(true);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });

  it("starts an old unbacked RUNS row after a recent touch", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDR" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "recovered runner",
          profileKey: "recovered-runner",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "recover old wake" });
      const plan = await prisma.executionPlan.create({
        data: {
          workspaceId: fixture.workspace.id,
          title: "Recovered plan context",
          status: "RUNNING",
        },
      });
      const step = await prisma.executionStep.create({
        data: {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          issueId: issue.id,
          title: "Recovered step context",
          position: 0,
          status: "RUNNING",
        },
      });
      const oldStartedAt = new Date(Date.now() - 2 * 60 * 60_000);
      const run = await prisma.agentRun.create({
        data: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          status: "ACTIVE",
          triggerKind: EventKind.COMMENT_CREATED,
          executionStepId: step.id,
          startedAt: oldStartedAt,
          lastEventAt: new Date(),
        },
      });

      const tick = await ingestRunsDispatch();
      expect(tick.started).toBeGreaterThanOrEqual(1);

      const after = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
        include: { events: { orderBy: { createdAt: "asc" } } },
      });
      expect(after.externalRunId).toMatch(/^mock-/);
      expect(after.orchestrationContextSnapshot).not.toBeNull();
      expect(after.events.some((e) => e.kind === "DISPATCH_STARTED")).toBe(true);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });

  it("does not dispatch an ACTIVE unbacked run that has no external trigger", async () => {
    // Guard against a self-perpetuating loop: a RUNS agent that completes a run
    // and then posts a comment makes openOrTouchRun create a fresh ACTIVE,
    // unbacked, trigger-less run. Dispatching it re-summons the agent forever.
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RDL" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "self opener",
          profileKey: "self-opener",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "no trigger" });
      // An ACTIVE, unbacked run with NO triggerKind — as openOrTouchRun creates
      // when an agent posts a comment with no live run.
      const run = await prisma.agentRun.create({
        data: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          status: "ACTIVE",
          lastEventAt: new Date(),
        },
      });

      await ingestRunsDispatch();

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.externalRunId).toBeNull(); // never dispatched
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });

  it("does not mark provider-terminal runs completed without runs.complete metadata", async () => {
    const previousE2E = process.env.FORGE_E2E;
    process.env.FORGE_E2E = "1";

    try {
      const fixture = await createWorkspaceFixture({ keyPrefix: "RPF" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const runtime = await prisma.runtime.create({
        data: {
          workspaceId: fixture.workspace.id,
          ownerId: fixture.user.id,
          name: "mock runs",
          kind: RuntimeKind.LOCAL_DAEMON,
          adapterKey: "mock-runs",
          providersAvailable: [AgentProvider.HERMES],
        },
        select: { id: true },
      });
      const agent = await prisma.agent.create({
        data: {
          workspaceId: fixture.workspace.id,
          name: "runner",
          profileKey: "runner-protocol",
          provider: AgentProvider.HERMES,
          runEngine: RunEngine.RUNS,
          runtimeId: runtime.id,
          status: "ONLINE",
        },
        select: { id: true },
      });
      const issue = await createIssue(fixture, { title: "poll terminal" });
      const run = await prisma.agentRun.create({
        data: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: agent.id,
          externalRunId: "mock-missing-terminal",
          status: "ACTIVE",
        },
      });

      const tick = await ingestRunsDispatch();
      expect(tick.polled).toBeGreaterThanOrEqual(1);

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe("STALLED");
      expect(after.summary).toMatch(/without a valid Forge runs\.complete contract/);
      expect(after.completionMeta).toBeNull();

      // A terminal failure must surface on the issue itself, not only in the
      // run overlay — posted as an agent-authored comment carrying the output.
      const comments = await prisma.comment.findMany({ where: { issueId: issue.id } });
      expect(
        comments.some((c) => c.authoringAgentId === agent.id && /run stalled/i.test(c.body)),
      ).toBe(true);
    } finally {
      if (previousE2E === undefined) {
        delete process.env.FORGE_E2E;
      } else {
        process.env.FORGE_E2E = previousE2E;
      }
    }
  });
});
