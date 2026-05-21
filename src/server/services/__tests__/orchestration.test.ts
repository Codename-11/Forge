import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ActionRequestStatus,
  ExecutionPlanStatus,
  ExecutionStepStatus,
  GoalStatus,
  ReviewGateStatus,
} from "@prisma/client";
import {
  abandonGoal,
  activatePlan,
  addStepsToPlan,
  cascadeReadiness,
  createGoal,
  decomposeGoal,
  getGoal,
  recordVerdict,
  requestPlanApproval,
} from "@/server/services/orchestration-service";
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
      steps: [
        { title: "root" },
        { title: "child", dependsOnStepIndexes: [0] },
      ],
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
        statusId: (await prisma.status.findFirstOrThrow({
          where: { workspaceId: fixture.workspace.id },
        })).id,
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
