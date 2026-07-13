import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ActionRequestStatus,
  AgentRunStatus,
  AgentProvider,
  EngagementMode,
  EventKind,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  GoalStatus,
  ReviewGateStatus,
  RuntimeKind,
} from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  abandonGoal,
  activatePlan,
  addStepsToPlan,
  attachPlanToGoal,
  cascadeReadiness,
  createGoal,
  decomposeGoal,
  dispatchJudge,
  getGoal,
  handoffCompletedRunToStep,
  maybeCompleteGoal,
  recordVerdict,
  requestPlanApproval,
  sweepOrchestrationBudget,
  updateGoal,
} from "@/server/services/orchestration-service";
import {
  createExecutionPlan,
  materializeStepAsIssue,
} from "@/server/services/execution-plan-service";
import {
  createAgentCrew,
  addCrewMember,
  setCrewMemberRole,
  updateAgentCrew,
  removeCrewMember,
  archiveAgentCrew,
} from "@/server/services/agent-crew-service";
import { acceptActionRequest } from "@/server/services/action-request-service";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the orchestration loop. Real Postgres + Redis
 * (no mocks per CLAUDE.md). Each test spins an isolated workspace.
 */

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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "ORC" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  return { fixture, prisma };
}

async function makeAgent(wsId: string, name: string) {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId: wsId,
      profileKey: `${name}-${Math.random().toString(36).slice(2, 8)}`,
      name,
    },
  });
}

describe("orchestration: goals", () => {
  it("reconciles completed step runs and raises one durable stalled-plan signal", async () => {
    const { fixture, prisma } = await setup();
    const agent = await makeAgent(fixture.workspace.id, "reconcile-worker");
    const issue = await createIssue(fixture);
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Recover completed work",
        status: ExecutionPlanStatus.RUNNING,
        startedAt: new Date(),
      },
    });
    const step = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        title: "Completed implementation",
        position: 0,
        status: ExecutionStepStatus.READY,
        assignedAgentId: agent.id,
        issueId: issue.id,
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        executionStepId: step.id,
        status: AgentRunStatus.COMPLETED,
        completedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        executionStepId: step.id,
        status: AgentRunStatus.STALLED,
        finishedAt: new Date(Date.now() - 60_000),
        lastEventAt: new Date(Date.now() - 60_000),
      },
    });

    const first = await sweepOrchestrationBudget({ workspaceId: fixture.workspace.id });
    expect(first.reconciled).toBeGreaterThanOrEqual(1);
    expect(first.stalled).toBeGreaterThanOrEqual(1);
    const after = await prisma.executionStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(after.status).toBe(ExecutionStepStatus.REVIEW);
    expect(after.sourceRunId).toBe(run.id);
    expect(
      await prisma.activityEvent.count({
        where: {
          workspaceId: fixture.workspace.id,
          kind: "PLAN_STALLED",
          subjectId: plan.id,
        },
      }),
    ).toBe(1);

    await sweepOrchestrationBudget({ workspaceId: fixture.workspace.id });
    expect(
      await prisma.activityEvent.count({
        where: {
          workspaceId: fixture.workspace.id,
          kind: "PLAN_STALLED",
          subjectId: plan.id,
        },
      }),
    ).toBe(1);
  });

  it("creates, gets, and abandons a goal", async () => {
    const { fixture, prisma } = await setup();
    const { id } = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Ship the thing",
      description: "do it well",
      successCriteria: "The release is live and verification passes.",
      targetDate: new Date("2026-08-01T12:00:00.000Z"),
      maxTotalCostUsd: 5,
    });
    const got = await getGoal(prisma, { workspaceId: fixture.workspace.id, id });
    expect(got.title).toBe("Ship the thing");
    expect(got.status).toBe(GoalStatus.OPEN);
    expect(got.maxTotalCostUsd).toBe(5);
    expect(got.successCriteria).toContain("verification passes");
    expect(got.targetDate?.toISOString()).toBe("2026-08-01T12:00:00.000Z");
    expect(got.aggregate.totalSteps).toBe(0);
    expect(got.operating).toMatchObject({
      health: "NEEDS_PLAN",
      nextAction: "Create an execution plan",
    });

    await abandonGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      id,
      reason: "scope creep",
    });
    const after = await getGoal(prisma, { workspaceId: fixture.workspace.id, id });
    expect(after.status).toBe(GoalStatus.ABANDONED);
  });

  it("updates goal metadata and mirrors budget caps to the active plan", async () => {
    const { fixture, prisma } = await setup();
    const { id } = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Original goal",
      maxTotalCostUsd: 3,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: id,
    });

    await updateGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      id,
      title: "Updated goal",
      description: "new detail",
      successCriteria: "All acceptance checks are green.",
      outcomeSummary: "The migration completed without downtime.",
      maxTotalCostUsd: 12,
      maxWallTimeMinutes: 45,
    });

    const goal = await getGoal(prisma, { workspaceId: fixture.workspace.id, id });
    expect(goal.title).toBe("Updated goal");
    expect(goal.description).toBe("new detail");
    expect(goal.successCriteria).toBe("All acceptance checks are green.");
    expect(goal.outcomeSummary).toContain("without downtime");
    expect(goal.maxTotalCostUsd).toBe(12);
    expect(goal.maxWallTimeMinutes).toBe(45);

    const plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.maxTotalCostUsd).toBe(12);
    expect(plan.maxWallTimeMinutes).toBe(45);
  });
});

describe("orchestration: decompose + addSteps", () => {
  it("decompose creates a DRAFT plan + dispatches the planner", async () => {
    const { fixture, prisma } = await setup();
    const planner = await makeAgent(fixture.workspace.id, "planner");
    await prisma.agent.update({
      where: { id: planner.id },
      data: { webhookUrl: "https://example.test/hook" },
    });
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew A",
      members: [{ agentId: planner.id, role: "PLANNER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Build feature",
      crewId: crew.id,
    });
    const res = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    expect(res.status).toBe("PLANNING");
    expect(res.plannerAgentId).toBe(planner.id);

    const plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: res.planId } });
    expect(plan.status).toBe(ExecutionPlanStatus.DRAFT);
    expect(plan.goalId).toBe(goal.id);
    expect(plan.isActiveAttempt).toBe(true);

    const g = await getGoal(prisma, { workspaceId: fixture.workspace.id, id: goal.id });
    expect(g.status).toBe(GoalStatus.PLANNING);

    // A webhook delivery should have been queued against the per-agent shim.
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { event: { workspaceId: fixture.workspace.id, subjectId: res.planId } },
      include: { webhook: true },
    });
    expect(deliveries.some((d) => d.webhook.url === `agent:dispatch:${planner.id}`)).toBe(true);

    // A second decompose marks the prior attempt inactive.
    const res2 = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const prior = await prisma.executionPlan.findUniqueOrThrow({ where: { id: res.planId } });
    const fresh = await prisma.executionPlan.findUniqueOrThrow({ where: { id: res2.planId } });
    expect(prior.isActiveAttempt).toBe(false);
    expect(fresh.isActiveAttempt).toBe(true);
  });

  it("opens a durable run for a runtime planner when the goal has an issue anchor", async () => {
    const { fixture, prisma } = await setup();
    const issue = await createIssue(fixture, { title: "Goal planning anchor" });
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerId: fixture.user.id,
        name: "Codex planner runtime",
        kind: RuntimeKind.LOCAL_DAEMON,
        adapterKey: "mock-runs",
        providersAvailable: [AgentProvider.HERMES],
      },
    });
    const planner = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: "runtime-planner",
        name: "Runtime Planner",
        provider: AgentProvider.HERMES,
        runEngine: "RUNS",
        runtimeId: runtime.id,
      },
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Plan through Codex",
      description: "Build a safe rollout plan.",
      successCriteria: "Every rollout stage has a rollback check.",
      issueId: issue.id,
    });

    const result = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
      plannerAgentId: planner.id,
    });

    expect(result.dispatchable).toBe(true);
    const run = await prisma.agentRun.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, agentId: planner.id },
    });
    expect(run).toMatchObject({
      issueId: issue.id,
      executionStepId: null,
      engagementMode: "DISCUSS",
      triggerKind: EventKind.ISSUE_UPDATED,
      status: AgentRunStatus.ACTIVE,
    });
    const event = await prisma.activityEvent.findUniqueOrThrow({
      where: { id: run.triggerEventId! },
    });
    expect(event.subjectId).toBe(result.planId);
    expect(event.payload).toMatchObject({
      goalId: goal.id,
      goalSuccessCriteria: "Every rollout stage has a rollback check.",
    });
    expect(
      await prisma.webhookDelivery.count({
        where: { eventId: event.id },
      }),
    ).toBe(0);
  });

  it("does not claim or queue runtime planner dispatch without a goal issue anchor", async () => {
    const { fixture, prisma } = await setup();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerId: fixture.user.id,
        name: "Unanchored planner runtime",
        kind: RuntimeKind.LOCAL_DAEMON,
        adapterKey: "mock-runs",
        providersAvailable: [AgentProvider.HERMES],
      },
    });
    const planner = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: "unanchored-planner",
        name: "Unanchored Planner",
        provider: AgentProvider.HERMES,
        runEngine: "RUNS",
        runtimeId: runtime.id,
      },
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "No issue anchor",
    });

    const result = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
      plannerAgentId: planner.id,
    });

    expect(result.dispatchable).toBe(false);
    expect(
      await prisma.agentRun.count({
        where: { workspaceId: fixture.workspace.id, agentId: planner.id },
      }),
    ).toBe(0);
    expect(
      await prisma.webhookDelivery.count({
        where: { event: { subjectId: result.planId } },
      }),
    ).toBe(0);
  });

  it("addSteps resolves index-based deps to real ids", async () => {
    const { fixture, prisma } = await setup();
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [
        { title: "root" },
        { title: "child", dependsOnStepIndexes: [0] },
        { title: "grandchild", dependsOnStepIndexes: [1] },
      ],
    });
    expect(stepIds).toHaveLength(3);
    const child = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[1] } });
    expect(child.dependsOnStepIds).toEqual([stepIds[0]]);
    const grandchild = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[2] } });
    expect(grandchild.dependsOnStepIds).toEqual([stepIds[1]]);
  });
});

describe("orchestration: readiness cascade", () => {
  it("completing a step flips its dependents TODO → READY", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew",
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "root" }, { title: "child", dependsOnStepIndexes: [0] }],
    });
    // Activate → root becomes READY, child stays TODO.
    await prisma.$transaction((tx) =>
      activatePlan(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        planId,
      }),
    );
    const root = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[0] } });
    let child = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[1] } });
    expect(root.status).toBe(ExecutionStepStatus.READY);
    expect(child.status).toBe(ExecutionStepStatus.TODO);
    expect(root.assignedAgentId).toBe(worker.id); // crew WORKER auto-assigned

    // Mark root DONE, then cascade.
    await prisma.executionStep.update({
      where: { id: stepIds[0] },
      data: { status: ExecutionStepStatus.DONE },
    });
    await prisma.$transaction((tx) =>
      cascadeReadiness(tx, {
        workspaceId: fixture.workspace.id,
        planId,
        actorId: fixture.user.id,
      }),
    );
    child = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[1] } });
    expect(child.status).toBe(ExecutionStepStatus.READY);
  });

  it("enforces maxParallel across concurrent plans owned by the same crew", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "shared-worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Serial crew",
      maxParallel: 1,
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const plans = await Promise.all(
      ["Plan A", "Plan B"].map((title) =>
        prisma.executionPlan.create({
          data: {
            workspaceId: fixture.workspace.id,
            title,
            crewId: crew.id,
          },
        }),
      ),
    );
    await Promise.all(
      plans.map((plan, position) =>
        prisma.executionStep.create({
          data: {
            workspaceId: fixture.workspace.id,
            planId: plan.id,
            title: `Root ${position + 1}`,
            position: 0,
          },
        }),
      ),
    );

    await Promise.all(
      plans.map((plan) =>
        prisma.$transaction((tx) =>
          activatePlan(tx, {
            workspaceId: fixture.workspace.id,
            actorId: fixture.user.id,
            planId: plan.id,
          }),
        ),
      ),
    );

    const steps = await prisma.executionStep.findMany({
      where: { planId: { in: plans.map((plan) => plan.id) } },
      select: { id: true, planId: true, status: true },
    });
    expect(steps.filter((step) => step.status === ExecutionStepStatus.READY)).toHaveLength(1);
    expect(steps.filter((step) => step.status === ExecutionStepStatus.TODO)).toHaveLength(1);

    const admitted = steps.find((step) => step.status === ExecutionStepStatus.READY)!;
    const queued = steps.find((step) => step.status === ExecutionStepStatus.TODO)!;
    expect(queued.planId).not.toBe(admitted.planId);
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: worker.id,
        executionStepId: admitted.id,
        status: AgentRunStatus.COMPLETED,
        completedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    await prisma.$transaction((tx) =>
      handoffCompletedRunToStep(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        runId: run.id,
        stepId: admitted.id,
      }),
    );
    const afterRelease = await prisma.executionStep.findMany({
      where: { id: { in: [admitted.id, queued.id] } },
      select: { id: true, status: true },
    });
    expect(afterRelease.find((step) => step.id === admitted.id)?.status).toBe(
      ExecutionStepStatus.REVIEW,
    );
    expect(afterRelease.find((step) => step.id === queued.id)?.status).toBe(
      ExecutionStepStatus.READY,
    );
  });

  it("releases a crew slot at REVIEW and admits the next ready sibling", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "serial-worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "One-at-a-time crew",
      maxParallel: 1,
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Two independent roots",
        crewId: crew.id,
      },
    });
    await prisma.executionStep.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          title: "First root",
          position: 0,
        },
        {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          title: "Second root",
          position: 1,
        },
      ],
    });
    await prisma.$transaction((tx) =>
      activatePlan(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        planId: plan.id,
      }),
    );
    const before = await prisma.executionStep.findMany({
      where: { planId: plan.id },
      orderBy: { position: "asc" },
    });
    const admitted = before.find((step) => step.status === ExecutionStepStatus.READY)!;
    const queued = before.find((step) => step.status === ExecutionStepStatus.TODO)!;
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: worker.id,
        executionStepId: admitted.id,
        status: AgentRunStatus.COMPLETED,
        completedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    await prisma.$transaction((tx) =>
      handoffCompletedRunToStep(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        runId: run.id,
        stepId: admitted.id,
      }),
    );

    const after = await prisma.executionStep.findMany({
      where: { id: { in: [admitted.id, queued.id] } },
      select: { id: true, status: true },
    });
    expect(after.find((step) => step.id === admitted.id)?.status).toBe(ExecutionStepStatus.REVIEW);
    expect(after.find((step) => step.id === queued.id)?.status).toBe(ExecutionStepStatus.READY);
  });

  it("serializes concurrent cross-plan releases before refilling crew slots", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "parallel-worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Two-slot crew",
      maxParallel: 2,
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const plans = await Promise.all(
      ["Concurrent A", "Concurrent B"].map((title) =>
        prisma.executionPlan.create({
          data: {
            workspaceId: fixture.workspace.id,
            title,
            crewId: crew.id,
            status: ExecutionPlanStatus.RUNNING,
            startedAt: new Date(),
          },
        }),
      ),
    );
    const pairs: Array<{ active: { id: string }; queued: { id: string }; run: { id: string } }> =
      [];
    // createIssue allocates the next workspace number, so keep fixture issue
    // creation sequential even though the releases below intentionally race.
    for (const plan of plans) {
      const active = await prisma.executionStep.create({
        data: {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          title: `${plan.title} active`,
          position: 0,
          status: ExecutionStepStatus.RUNNING,
          assignedAgentId: worker.id,
        },
      });
      const queued = await prisma.executionStep.create({
        data: {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          title: `${plan.title} queued`,
          position: 1,
        },
      });
      const issue = await createIssue(fixture);
      const run = await prisma.agentRun.create({
        data: {
          workspaceId: fixture.workspace.id,
          issueId: issue.id,
          agentId: worker.id,
          executionStepId: active.id,
          status: AgentRunStatus.COMPLETED,
          completedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      pairs.push({ active, queued, run });
    }

    await Promise.all(
      pairs.map(({ active, run }) =>
        prisma.$transaction((tx) =>
          handoffCompletedRunToStep(tx, {
            workspaceId: fixture.workspace.id,
            actorId: fixture.user.id,
            runId: run.id,
            stepId: active.id,
          }),
        ),
      ),
    );

    const settled = await prisma.executionStep.findMany({
      where: { planId: { in: plans.map((plan) => plan.id) } },
      select: { id: true, status: true },
    });
    for (const pair of pairs) {
      expect(settled.find((step) => step.id === pair.active.id)?.status).toBe(
        ExecutionStepStatus.REVIEW,
      );
      expect(settled.find((step) => step.id === pair.queued.id)?.status).toBe(
        ExecutionStepStatus.READY,
      );
    }
  });
});

describe("orchestration: judge loop", () => {
  async function buildRunningPlanWithStep(opts: { maxStepRetries?: number } = {}) {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "worker");
    const reviewer = await makeAgent(fixture.workspace.id, "reviewer");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew",
      members: [
        { agentId: worker.id, role: "WORKER" },
        { agentId: reviewer.id, role: "REVIEWER" },
      ],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    if (opts.maxStepRetries !== undefined) {
      await prisma.executionPlan.update({
        where: { id: planId },
        data: { maxStepRetries: opts.maxStepRetries },
      });
    }
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "only step", expectedOutput: "a thing" }],
    });
    await prisma.$transaction((tx) =>
      activatePlan(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        planId,
      }),
    );
    await prisma.executionStep.update({
      where: { id: stepIds[0] },
      data: { status: ExecutionStepStatus.REVIEW },
    });
    return {
      fixture,
      prisma,
      planId,
      stepId: stepIds[0],
      goalId: goal.id,
      reviewerId: reviewer.id,
    };
  }

  it("dispatches review as a first-class REVIEW run and closes it with the verdict", async () => {
    const { fixture, prisma, stepId, reviewerId } = await buildRunningPlanWithStep();
    await prisma.executionStep.update({
      where: { id: stepId },
      data: { status: ExecutionStepStatus.REVIEW },
    });

    const dispatched = await dispatchJudge(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId,
    });

    expect(dispatched.judgeAgentId).toBe(reviewerId);
    expect(dispatched.runId).toBeTruthy();
    expect(dispatched.issueId).toBeTruthy();
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.runId! } });
    expect(run).toMatchObject({
      agentId: reviewerId,
      executionStepId: stepId,
      engagementMode: EngagementMode.REVIEW,
      status: AgentRunStatus.ACTIVE,
    });

    await recordVerdict(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: null,
      actorAgentId: reviewerId,
      stepId,
      verdict: "PASS",
      feedback: "reviewed and approved",
    });
    const completed = await prisma.agentRun.findUniqueOrThrow({
      where: { id: dispatched.runId! },
    });
    expect(completed.status).toBe(AgentRunStatus.COMPLETED);
    expect(completed.completedAt).not.toBeNull();
  });

  it("opens a human fallback when an agent review never acknowledges", async () => {
    const { fixture, prisma, stepId } = await buildRunningPlanWithStep();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { reviewStartTimeoutMinutes: 1 },
    });
    await prisma.executionStep.update({
      where: { id: stepId },
      data: { status: ExecutionStepStatus.REVIEW },
    });
    const dispatched = await dispatchJudge(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId,
    });
    const old = new Date(Date.now() - 2 * 60_000);
    await prisma.agentRun.update({
      where: { id: dispatched.runId! },
      data: { startedAt: old, lastEventAt: old, lastWakeAt: old, acknowledgedAt: null },
    });

    const result = await sweepOrchestrationBudget({ workspaceId: fixture.workspace.id });

    expect(result.stalled).toBeGreaterThanOrEqual(1);
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.runId! } });
    expect(run.status).toBe(AgentRunStatus.STALLED);
    const gate = await prisma.reviewGate.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        targetType: "execution-step",
        targetId: stepId,
        status: ReviewGateStatus.PENDING,
      },
    });
    expect(gate?.prompt).toContain("did not start");
  });

  it("judge PASS marks the step DONE and achieves the goal", async () => {
    const { fixture, prisma, stepId, goalId } = await buildRunningPlanWithStep();
    const res = await recordVerdict(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId,
      verdict: "PASS",
      feedback: "looks good",
      score: 0.9,
    });
    expect(res.outcome).toBe("DONE");
    const step = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepId } });
    expect(step.status).toBe(ExecutionStepStatus.DONE);
    const verdict = step.judgeVerdict as { verdict: string; score: number };
    expect(verdict.verdict).toBe("PASS");
    expect(verdict.score).toBe(0.9);
    // Single step done → goal ACHIEVED.
    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(goal.status).toBe(GoalStatus.ACHIEVED);
    expect(goal.achievedAt).not.toBeNull();
  });

  it("rejects a verdict before the step reaches review", async () => {
    const { fixture, prisma, stepId } = await buildRunningPlanWithStep();
    await prisma.executionStep.update({
      where: { id: stepId },
      data: { status: ExecutionStepStatus.TODO },
    });

    await expect(
      recordVerdict(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        stepId,
        verdict: "PASS",
        feedback: "Skip straight to done",
      }),
    ).rejects.toThrow(/only be recorded while it is in review/);

    const step = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepId } });
    expect(step.status).toBe(ExecutionStepStatus.TODO);
  });

  it("does not achieve a goal when any step was canceled", async () => {
    const { fixture, prisma, planId, goalId, stepId } = await buildRunningPlanWithStep();
    await prisma.executionStep.update({
      where: { id: stepId },
      data: { status: ExecutionStepStatus.DONE },
    });
    await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId,
        title: "Canceled deliverable",
        position: 1,
        status: ExecutionStepStatus.CANCELED,
      },
    });

    await prisma.$transaction((tx) =>
      maybeCompleteGoal(tx, {
        workspaceId: fixture.workspace.id,
        planId,
        actorId: fixture.user.id,
      }),
    );

    const plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(plan.status).toBe(ExecutionPlanStatus.RUNNING);
    expect(goal.status).toBe(GoalStatus.ACTIVE);
    expect(goal.achievedAt).toBeNull();
  });

  it("judge FAIL with retries left re-readies the step and bumps retryCount", async () => {
    const { fixture, prisma, stepId } = await buildRunningPlanWithStep({ maxStepRetries: 2 });
    const res = await recordVerdict(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId,
      verdict: "FAIL",
      feedback: "missing X",
    });
    expect(res.outcome).toBe("RETRY");
    expect(res.retryCount).toBe(1);
    const step = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepId } });
    expect(step.status).toBe(ExecutionStepStatus.READY);
    expect(step.retryCount).toBe(1);
    expect(step.lastFeedback).toBe("missing X");
  });

  it("judge FAIL with retries exhausted BLOCKs the step and opens a ReviewGate", async () => {
    const { fixture, prisma, stepId } = await buildRunningPlanWithStep({ maxStepRetries: 0 });
    const res = await recordVerdict(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId,
      verdict: "FAIL",
      feedback: "still broken",
    });
    expect(res.outcome).toBe("BLOCKED");
    const step = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepId } });
    expect(step.status).toBe(ExecutionStepStatus.BLOCKED);
    const gate = await prisma.reviewGate.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        targetType: "execution-step",
        targetId: stepId,
        status: ReviewGateStatus.PENDING,
      },
    });
    expect(gate).not.toBeNull();
  });
});

describe("orchestration: budget breach", () => {
  it("recordUsage over the cap BLOCKs the plan + opens a ReviewGate", async () => {
    const { fixture, prisma } = await setup();
    const { applyRunCostToPlan } = await import("@/server/services/orchestration-service");
    const agent = await makeAgent(fixture.workspace.id, "worker");
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
      maxTotalCostUsd: 1,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "step" }],
    });
    await prisma.$transaction((tx) =>
      activatePlan(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        planId,
      }),
    );
    // Tie a run to the step.
    const issue = await prisma.issue.create({
      data: {
        workspaceId: fixture.workspace.id,
        number: 1,
        title: "x",
        statusId: (
          await prisma.status.findFirstOrThrow({
            where: { workspaceId: fixture.workspace.id },
          })
        ).id,
        authorId: fixture.user.id,
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });
    await prisma.executionStep.update({
      where: { id: stepIds[0] },
      data: { sourceRunId: run.id },
    });
    const res = await applyRunCostToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      runId: run.id,
      costDelta: 2.5, // > cap of 1
    });
    expect(res.breached).toBe(true);
    const plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe(ExecutionPlanStatus.BLOCKED);
    expect(plan.totalCostUsd).toBeCloseTo(2.5);
    const g = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(g.totalCostUsd).toBeCloseTo(2.5);
    const gate = await prisma.reviewGate.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        targetType: "execution-plan",
        targetId: planId,
      },
    });
    expect(gate).not.toBeNull();
  });
});

describe("orchestration: plan approval", () => {
  it("accepting the approval ActionRequest activates the plan + goal", async () => {
    const { fixture, prisma } = await setup();
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "step a" }, { title: "step b" }],
    });
    const { actionRequestId } = await requestPlanApproval(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      assignedUserId: fixture.user.id,
    });
    const req = await prisma.actionRequest.findUniqueOrThrow({ where: { id: actionRequestId } });
    expect(req.sourceType).toBe("execution-plan");
    expect(req.sourceId).toBe(planId);

    await acceptActionRequest(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      requestId: actionRequestId,
    });
    const after = await prisma.actionRequest.findUniqueOrThrow({ where: { id: actionRequestId } });
    expect(after.status).toBe(ActionRequestStatus.RESOLVED);
    const plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe(ExecutionPlanStatus.RUNNING);
    const g = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(g.status).toBe(GoalStatus.ACTIVE);
    expect(g.startedAt).not.toBeNull();
  });
});

describe("orchestration: agentCrews CRUD", () => {
  it("creates, updates, manages members, and archives a crew", async () => {
    const { fixture, prisma } = await setup();
    const a = await makeAgent(fixture.workspace.id, "a");
    const b = await makeAgent(fixture.workspace.id, "b");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew X",
      members: [{ agentId: a.id, role: "PLANNER" }],
    });
    await updateAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      crewId: crew.id,
      name: "Crew X v2",
      maxParallel: 3,
    });
    let row = await prisma.agentCrew.findUniqueOrThrow({ where: { id: crew.id } });
    expect(row.name).toBe("Crew X v2");
    expect(row.maxParallel).toBe(3);

    const member = await addCrewMember(prisma, {
      workspaceId: fixture.workspace.id,
      crewId: crew.id,
      agentId: b.id,
      role: "WORKER",
      actorId: fixture.user.id,
    });
    await setCrewMemberRole(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      memberId: member.id,
      role: "REVIEWER",
    });
    const members = await prisma.agentCrewMember.findMany({ where: { crewId: crew.id } });
    expect(members.find((m) => m.agentId === b.id)?.role).toBe("REVIEWER");

    const reviewerMember = members.find((m) => m.agentId === b.id)!;
    await removeCrewMember(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      memberId: reviewerMember.id,
    });
    const remaining = await prisma.agentCrewMember.findMany({ where: { crewId: crew.id } });
    expect(remaining.some((m) => m.agentId === b.id)).toBe(false);

    await archiveAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      crewId: crew.id,
    });
    row = await prisma.agentCrew.findUniqueOrThrow({ where: { id: crew.id } });
    expect(row.archivedAt).not.toBeNull();
  });
});

describe("orchestration: materialize step as issue (AXI-56)", () => {
  it("creates a linked issue carrying the step's contract, idempotently", async () => {
    const { fixture, prisma } = await setup();
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Plan with a step",
      steps: [
        {
          title: "Wire the resolver",
          body: "Implement resolveX()",
          expectedOutput: "resolveX returns correctly",
          verification: [{ label: "unit tests green", kind: "command", value: "pnpm test" }],
        },
      ],
    });
    const step = await prisma.executionStep.findFirstOrThrow({ where: { planId } });
    expect(step.issueId).toBeNull();

    const res = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: step.id,
    });
    expect(res.created).toBe(true);

    const issue = await prisma.issue.findUniqueOrThrow({ where: { id: res.issueId } });
    expect(issue.title).toBe("Wire the resolver");
    expect(issue.description).toBe("Implement resolveX()");
    expect(issue.expectedOutput).toBe("resolveX returns correctly");
    expect(issue.verificationChecklist).not.toBeNull();

    const relinked = await prisma.executionStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(relinked.issueId).toBe(res.issueId);

    // Idempotent: second call returns the same issue, creates nothing new.
    const again = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: step.id,
    });
    expect(again).toEqual({ issueId: res.issueId, created: false });
  });

  it("carries an unambiguous step through ordinary issue assignment", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "reassigned-worker");
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Assignment-linked plan",
      steps: [{ title: "Assigned through issue" }],
    });
    const step = await prisma.executionStep.findFirstOrThrow({ where: { planId } });
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: step.id,
    });
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.RUNNING, startedAt: new Date() },
    });
    await prisma.executionStep.update({
      where: { id: step.id },
      data: { status: ExecutionStepStatus.READY },
    });
    await prisma.issue.update({
      where: { id: issueId },
      data: { assignedAgentId: worker.id },
    });

    await prisma.$transaction((tx) =>
      recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issueId,
        action: "assign-agent",
        eventKind: EventKind.AGENT_ASSIGNED,
        subjectType: "issue",
        subjectId: issueId,
        payload: { agentId: worker.id },
      }),
    );

    const linked = await prisma.executionStep.findUniqueOrThrow({ where: { id: step.id } });
    expect(linked.assignedAgentId).toBe(worker.id);
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_ASSIGNED,
        subjectId: issueId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(event.payload).toMatchObject({
      agentId: worker.id,
      executionStepId: step.id,
    });
  });

  it("schedules a blocked child assignee without dispatching work early", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "scheduled-worker");
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Dependency-gated assignment",
      steps: [{ title: "Root" }, { title: "Blocked child", dependsOnStepIndexes: [0] }],
    });
    const steps = await prisma.executionStep.findMany({
      where: { planId },
      orderBy: { position: "asc" },
    });
    const child = steps[1];
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: child.id,
    });
    await prisma.issue.update({
      where: { id: issueId },
      data: { assignedAgentId: worker.id },
    });

    await prisma.$transaction((tx) =>
      recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issueId,
        action: "assign-agent",
        eventKind: EventKind.AGENT_ASSIGNED,
        subjectType: "issue",
        subjectId: issueId,
        payload: { agentId: worker.id },
      }),
    );

    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_ASSIGNED,
        subjectId: issueId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(event.payload).toMatchObject({
      planId,
      planStepId: child.id,
      orchestrationDeferred: true,
    });
    expect((event.payload as { executionStepId?: string }).executionStepId).toBeUndefined();
    expect(
      await prisma.agentRun.count({
        where: { workspaceId: fixture.workspace.id, issueId },
      }),
    ).toBe(0);
    expect(
      await prisma.webhookDelivery.count({
        where: { eventId: event.id },
      }),
    ).toBe(0);
    const linked = await prisma.executionStep.findUniqueOrThrow({ where: { id: child.id } });
    expect(linked.status).toBe(ExecutionStepStatus.TODO);
    expect(linked.assignedAgentId).toBe(worker.id);
  });
});

describe("orchestration: Goal loop opens observable runs (AXI-57)", () => {
  it("activating a plan opens an AgentRun tagged with executionStepId on the step's issue", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew",
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "root" }],
    });
    // Materialize the step so the run binds to the step's own issue (Phase 1).
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: stepIds[0],
    });

    await prisma.$transaction((tx) =>
      activatePlan(tx, { workspaceId: fixture.workspace.id, actorId: fixture.user.id, planId }),
    );

    const run = await prisma.agentRun.findFirstOrThrow({
      where: { executionStepId: stepIds[0] },
    });
    expect(run.issueId).toBe(issueId);
    expect(run.agentId).toBe(worker.id);
    expect(run.status).toBe("ACTIVE");
    expect(run.currentStep).toBe("root");
  });

  it("auto-materializes freestanding steps for runtime-only workers", async () => {
    const { fixture, prisma } = await setup();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Codex runtime",
        kind: RuntimeKind.LOCAL_DAEMON,
        adapterKey: "mock-runs",
        providersAvailable: [AgentProvider.HERMES],
      },
      select: { id: true },
    });
    const worker = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: "codex-worker",
        name: "Codex Worker",
        provider: AgentProvider.HERMES,
        runtimeId: runtime.id,
      },
    });
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Runtime crew",
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Freestanding goal",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "Root runtime step", body: "Do the work" }],
    });

    await prisma.$transaction((tx) =>
      activatePlan(tx, { workspaceId: fixture.workspace.id, actorId: fixture.user.id, planId }),
    );

    const step = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[0] } });
    expect(step.status).toBe(ExecutionStepStatus.READY);
    expect(step.assignedAgentId).toBe(worker.id);
    expect(step.issueId).toBeTruthy();

    const issue = await prisma.issue.findUniqueOrThrow({ where: { id: step.issueId! } });
    expect(issue.title).toBe("Root runtime step");
    expect(issue.assignedAgentId).toBe(worker.id);

    const run = await prisma.agentRun.findFirstOrThrow({
      where: { executionStepId: step.id },
    });
    expect(run.issueId).toBe(issue.id);
    expect(run.agentId).toBe(worker.id);
    expect(run.triggerKind).toBe("EXECUTION_STEP_READY");
    expect(run.triggerEventId).toBeTruthy();

    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: AgentRunStatus.STALLED,
        summary: "Runtime credentials need attention.",
      },
    });
    const hydratedGoal = await getGoal(prisma, {
      workspaceId: fixture.workspace.id,
      id: goal.id,
    });
    const hydratedStep = hydratedGoal.plans
      .flatMap((plan) => plan.steps)
      .find((candidate) => candidate.id === step.id);
    expect(hydratedStep?.runs[0]?.status).toBe(AgentRunStatus.STALLED);
    expect(hydratedStep?.runs[0]?.summary).toBe("Runtime credentials need attention.");

    const deadWebhook = await prisma.webhookDelivery.findFirst({
      where: { webhook: { url: `agent:dispatch:${worker.id}` } },
    });
    expect(deadWebhook).toBeNull();
  });
});

describe("orchestration: goal under initiative (AXI-58)", () => {
  it("links a goal to an initiative; rejects a cross-workspace initiative", async () => {
    const { fixture, prisma } = await setup();
    const initiative = await prisma.initiative.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Q3 bet",
        slug: `q3-${Math.random().toString(36).slice(2, 8)}`,
        createdById: fixture.user.id,
      },
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Advance the bet",
      initiativeId: initiative.id,
    });
    const row = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(row.initiativeId).toBe(initiative.id);

    await expect(
      createGoal(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        title: "Bad",
        initiativeId: "cmaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toThrow(/Initiative not found/);
  });
});

describe("execution plans: author a DAG at create time (AXI-54 gap 2)", () => {
  it("resolves dependsOnStepIndexes → real step ids in one create call", async () => {
    const { fixture, prisma } = await setup();
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "DAG at create",
      steps: [
        { title: "root" },
        { title: "child", dependsOnStepIndexes: [0] },
        { title: "leaf", dependsOnStepIndexes: [1] },
      ],
    });
    const steps = await prisma.executionStep.findMany({
      where: { planId },
      orderBy: { position: "asc" },
    });
    expect(steps[0].dependsOnStepIds).toEqual([]);
    expect(steps[1].dependsOnStepIds).toEqual([steps[0].id]); // index 0 → root id
    expect(steps[2].dependsOnStepIds).toEqual([steps[1].id]);

    await expect(
      createExecutionPlan(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        title: "Invalid DAG",
        steps: [{ title: "self", dependsOnStepIndexes: [0] }],
      }),
    ).rejects.toThrow(/cannot depend on itself/);
  });
});

describe("orchestration: attach hand-authored plan to goal", () => {
  it("links a plan to a goal as its active attempt", async () => {
    const { fixture, prisma } = await setup();
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Ship the thing",
    });
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Hand-authored plan",
    });

    // Created standalone — not yet linked.
    let plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.goalId).toBeNull();

    const res = await attachPlanToGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
      planId,
    });
    expect(res).toEqual({ planId, goalId: goal.id });

    plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.goalId).toBe(goal.id);
    expect(plan.isActiveAttempt).toBe(true);
  });

  it("createExecutionPlan with goalId links + demotes the prior active attempt", async () => {
    const { fixture, prisma } = await setup();
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Multi-attempt goal",
    });
    const { id: firstId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Attempt 1",
      goalId: goal.id,
    });
    const { id: secondId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Attempt 2",
      goalId: goal.id,
    });

    const first = await prisma.executionPlan.findUniqueOrThrow({ where: { id: firstId } });
    const second = await prisma.executionPlan.findUniqueOrThrow({ where: { id: secondId } });
    expect(first.goalId).toBe(goal.id);
    expect(first.isActiveAttempt).toBe(false); // demoted
    expect(second.goalId).toBe(goal.id);
    expect(second.isActiveAttempt).toBe(true); // newest active

    const active = await prisma.executionPlan.count({
      where: { goalId: goal.id, isActiveAttempt: true },
    });
    expect(active).toBe(1);
  });

  it("createExecutionPlan resolves seeded step dependencies by input index", async () => {
    const { fixture, prisma } = await setup();
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Indexed DAG plan",
      steps: [
        { title: "root" },
        { title: "child", dependsOnStepIndexes: [0] },
        { title: "grandchild", dependsOnStepIndexes: [1] },
      ],
    });

    const steps = await prisma.executionStep.findMany({
      where: { planId },
      orderBy: { position: "asc" },
      select: { id: true, dependsOnStepIds: true },
    });
    expect(steps).toHaveLength(3);
    expect(steps[1].dependsOnStepIds).toEqual([steps[0].id]);
    expect(steps[2].dependsOnStepIds).toEqual([steps[1].id]);
  });

  it("refuses to attach a plan already owned by a different goal", async () => {
    const { fixture, prisma } = await setup();
    const goalA = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal A",
    });
    const goalB = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal B",
    });
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Owned plan",
      goalId: goalA.id,
    });

    await expect(
      attachPlanToGoal(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        goalId: goalB.id,
        planId,
      }),
    ).rejects.toThrow(/different goal/);
  });
});

describe("orchestration: audit phase-1 safety guards", () => {
  // Build a 2-step plan (child depends on root), activated so root is READY.
  async function build2StepRunning() {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew",
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "root" }, { title: "child", dependsOnStepIndexes: [0] }],
    });
    await prisma.$transaction((tx) =>
      activatePlan(tx, { workspaceId: fixture.workspace.id, actorId: fixture.user.id, planId }),
    );
    return { fixture, prisma, planId, rootId: stepIds[0], childId: stepIds[1] };
  }

  it("P1.1 — a BLOCKED plan does not cascade dependents into dispatch", async () => {
    const { fixture, prisma, planId, rootId, childId } = await build2StepRunning();
    // Simulate the budget watchdog blocking the plan mid-flight.
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.BLOCKED },
    });
    // Root finishes; a cascade must NOT ready the child while BLOCKED.
    await prisma.executionStep.update({
      where: { id: rootId },
      data: { status: ExecutionStepStatus.DONE },
    });
    const flipped = await prisma.$transaction((tx) =>
      cascadeReadiness(tx, { workspaceId: fixture.workspace.id, planId, actorId: fixture.user.id }),
    );
    expect(flipped).toEqual([]);
    let child = await prisma.executionStep.findUniqueOrThrow({ where: { id: childId } });
    expect(child.status).toBe(ExecutionStepStatus.TODO);

    // Resuming the plan lets the cascade proceed — proves the gate was the
    // only thing holding dispatch, not a stuck dependency.
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.RUNNING },
    });
    await prisma.$transaction((tx) =>
      cascadeReadiness(tx, { workspaceId: fixture.workspace.id, planId, actorId: fixture.user.id }),
    );
    child = await prisma.executionStep.findUniqueOrThrow({ where: { id: childId } });
    expect(child.status).toBe(ExecutionStepStatus.READY);
  });

  it("P1.1 — a CANCELED plan does not re-open work via a late retry verdict", async () => {
    const { fixture, prisma, planId, rootId } = await build2StepRunning();
    await prisma.executionStep.update({
      where: { id: rootId },
      data: { status: ExecutionStepStatus.REVIEW },
    });
    // Cancel the plan (as abandonGoal would), while root is still in flight.
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.CANCELED },
    });
    // A late reviewer verdict cannot mutate a plan after cancellation.
    await expect(
      recordVerdict(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        stepId: rootId,
        verdict: "FAIL",
        feedback: "late",
      }),
    ).rejects.toThrow(/active running plan attempt/);
    const root = await prisma.executionStep.findUniqueOrThrow({ where: { id: rootId } });
    expect(root.status).toBe(ExecutionStepStatus.REVIEW);
  });

  it("P1.2 — a stale verdict on a settled (DONE) step is rejected, keeping it DONE", async () => {
    const { fixture, prisma, rootId } = await build2StepRunning();
    await prisma.executionStep.update({
      where: { id: rootId },
      data: { status: ExecutionStepStatus.REVIEW },
    });
    // First verdict completes the step.
    const first = await recordVerdict(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: rootId,
      verdict: "PASS",
      feedback: "ok",
    });
    expect(first.outcome).toBe("DONE");
    // A stale/duplicate FAIL webhook must not reopen the finished step.
    await expect(
      recordVerdict(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        stepId: rootId,
        verdict: "FAIL",
        feedback: "stale",
      }),
    ).rejects.toThrow(/only be recorded while it is in review/);
    const step = await prisma.executionStep.findUniqueOrThrow({ where: { id: rootId } });
    expect(step.status).toBe(ExecutionStepStatus.DONE);
    expect(step.retryCount).toBe(0);
  });

  it("P1.7 — activatePlan stamps startedAt for the wall-time clock", async () => {
    const { fixture, prisma } = await setup();
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "only" }],
    });
    const before = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(before.startedAt).toBeNull();
    await prisma.$transaction((tx) =>
      activatePlan(tx, { workspaceId: fixture.workspace.id, actorId: fixture.user.id, planId }),
    );
    const after = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(after.startedAt).not.toBeNull();
  });
});

describe("orchestration: audit phase-2 lifecycle + integrity", () => {
  it("resolves assignedRole only when the plan crew has one unambiguous member", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "worker-role");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Role crew",
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Role resolution",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });

    const added = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "Assigned by role", assignedRole: "worker" }],
    });
    const assigned = await prisma.executionStep.findUniqueOrThrow({
      where: { id: added.stepIds[0] },
      select: { assignedAgentId: true },
    });
    expect(assigned.assignedAgentId).toBe(worker.id);

    const handAuthored = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Hand-authored role plan",
      goalId: goal.id,
    });
    expect(
      (await prisma.executionPlan.findUniqueOrThrow({ where: { id: handAuthored.id } })).crewId,
    ).toBe(crew.id);
    const handAuthoredStep = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId: handAuthored.id,
      steps: [{ title: "Inherited crew role", assignedRole: "WORKER" }],
    });
    expect(
      (
        await prisma.executionStep.findUniqueOrThrow({
          where: { id: handAuthoredStep.stepIds[0] },
          select: { assignedAgentId: true },
        })
      ).assignedAgentId,
    ).toBe(worker.id);

    const secondWorker = await makeAgent(fixture.workspace.id, "worker-role-two");
    await addCrewMember(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      crewId: crew.id,
      agentId: secondWorker.id,
      role: "WORKER",
    });
    await expect(
      addStepsToPlan(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        planId,
        steps: [{ title: "Ambiguous", assignedRole: "WORKER" }],
      }),
    ).rejects.toThrow(/role is ambiguous/);
    expect(await prisma.executionStep.count({ where: { planId } })).toBe(1);

    const explicit = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [
        {
          title: "Explicitly disambiguated",
          assignedRole: "WORKER",
          assignedAgentId: secondWorker.id,
        },
      ],
    });
    expect(
      (
        await prisma.executionStep.findUniqueOrThrow({
          where: { id: explicit.stepIds[0] },
          select: { assignedAgentId: true },
        })
      ).assignedAgentId,
    ).toBe(secondWorker.id);
  });

  it("P2.3 — rejects a plan whose steps form a dependency cycle", async () => {
    const { fixture, prisma } = await setup();
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    // step 0 depends on step 1 and step 1 depends on step 0 → cycle.
    await expect(
      addStepsToPlan(prisma, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        planId,
        steps: [
          { title: "a", dependsOnStepIndexes: [1] },
          { title: "b", dependsOnStepIndexes: [0] },
        ],
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it("P2.2 — abandoning a goal cancels its plan's non-terminal steps", async () => {
    const { fixture, prisma } = await setup();
    const worker = await makeAgent(fixture.workspace.id, "worker");
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Crew",
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const goal = await createGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Goal",
      crewId: crew.id,
    });
    const { planId } = await decomposeGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      goalId: goal.id,
    });
    const { stepIds } = await addStepsToPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      planId,
      steps: [{ title: "root" }, { title: "child", dependsOnStepIndexes: [0] }],
    });
    await prisma.$transaction((tx) =>
      activatePlan(tx, { workspaceId: fixture.workspace.id, actorId: fixture.user.id, planId }),
    );
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: stepIds[0],
    });
    // root READY, child TODO. Abandon → both CANCELED, plan CANCELED.
    await abandonGoal(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      id: goal.id,
    });
    const root = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[0] } });
    const child = await prisma.executionStep.findUniqueOrThrow({ where: { id: stepIds[1] } });
    expect(root.status).toBe(ExecutionStepStatus.CANCELED);
    expect(child.status).toBe(ExecutionStepStatus.CANCELED);
    const plan = await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe(ExecutionPlanStatus.CANCELED);
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { status: { select: { category: true } } },
        })
      ).status.category,
    ).toBe("CANCELED");
  });
});
