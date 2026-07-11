import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ActionRequestStatus,
  AgentRunStatus,
  AgentProvider,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  GoalStatus,
  ReviewGateStatus,
  RuntimeKind,
} from "@prisma/client";
import {
  abandonGoal,
  activatePlan,
  addStepsToPlan,
  attachPlanToGoal,
  cascadeReadiness,
  createGoal,
  decomposeGoal,
  getGoal,
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
      maxTotalCostUsd: 5,
    });
    const got = await getGoal(prisma, { workspaceId: fixture.workspace.id, id });
    expect(got.title).toBe("Ship the thing");
    expect(got.status).toBe(GoalStatus.OPEN);
    expect(got.maxTotalCostUsd).toBe(5);
    expect(got.aggregate.totalSteps).toBe(0);

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
      maxTotalCostUsd: 12,
      maxWallTimeMinutes: 45,
    });

    const goal = await getGoal(prisma, { workspaceId: fixture.workspace.id, id });
    expect(goal.title).toBe("Updated goal");
    expect(goal.description).toBe("new detail");
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
    return { fixture, prisma, planId, stepId: stepIds[0], goalId: goal.id };
  }

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
        { title: "self-ref-dropped", dependsOnStepIndexes: [2, 99] },
      ],
    });
    const steps = await prisma.executionStep.findMany({
      where: { planId },
      orderBy: { position: "asc" },
    });
    expect(steps[0].dependsOnStepIds).toEqual([]);
    expect(steps[1].dependsOnStepIds).toEqual([steps[0].id]); // index 0 → root id
    expect(steps[2].dependsOnStepIds).toEqual([]); // self + out-of-range dropped
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
    // Cancel the plan (as abandonGoal would), while root is still in flight.
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.CANCELED },
    });
    // A late FAIL verdict arrives on the still-READY root. It should record
    // (root is not settled) but the RETRY re-dispatch must be a no-op on a
    // CANCELED plan — the step lands TODO and is NOT re-readied.
    const res = await recordVerdict(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: rootId,
      verdict: "FAIL",
      feedback: "late",
    });
    expect(res.outcome).toBe("RETRY");
    const root = await prisma.executionStep.findUniqueOrThrow({ where: { id: rootId } });
    expect(root.status).toBe(ExecutionStepStatus.TODO); // not re-READY
  });

  it("P1.2 — a stale verdict on a settled (DONE) step is rejected, keeping it DONE", async () => {
    const { fixture, prisma, rootId } = await build2StepRunning();
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
    ).rejects.toThrow(/settled/);
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
  });
});
