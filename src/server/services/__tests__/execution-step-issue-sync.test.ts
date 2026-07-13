import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventKind, ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  createExecutionPlan,
  materializeStepAsIssue,
} from "@/server/services/execution-plan-service";
import { createAgentCrew } from "@/server/services/agent-crew-service";
import { markExecutionStepRunning } from "@/server/services/execution-step-runtime";
import { syncMaterializedIssueStatusFromStep } from "@/server/services/execution-step-issue-sync";
import {
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

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "SI" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const review = await prisma.status.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "In Review",
      category: "IN_REVIEW",
      color: "#ca8a04",
      position: 3,
    },
  });
  const started = await prisma.status.findFirstOrThrow({
    where: { workspaceId: fixture.workspace.id, category: "IN_PROGRESS" },
  });
  await prisma.workspace.update({
    where: { id: fixture.workspace.id },
    data: { startedStatusId: started.id, reviewStatusId: review.id },
  });
  return { fixture, prisma };
}

describe("materialized execution-step status synchronization", () => {
  it("projects READY, RUNNING, REVIEW, and DONE step states onto the Issue", async () => {
    const { fixture, prisma } = await setup();
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Projection plan",
      steps: [{ title: "Projected step" }],
    });
    const step = await prisma.executionStep.findFirstOrThrow({ where: { planId } });
    await prisma.executionStep.update({
      where: { id: step.id },
      data: { status: ExecutionStepStatus.READY },
    });
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: step.id,
    });
    const category = async () =>
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { status: { select: { category: true } } },
        })
      ).status.category;
    expect(await category()).toBe("TODO");

    await prisma.$transaction((tx) =>
      markExecutionStepRunning(tx, {
        workspaceId: fixture.workspace.id,
        executionStepId: step.id,
        runId: "run-status-projection",
      }),
    );
    expect(await category()).toBe("IN_PROGRESS");

    await prisma.$transaction(async (tx) => {
      await tx.executionStep.update({
        where: { id: step.id },
        data: { status: ExecutionStepStatus.REVIEW },
      });
      await syncMaterializedIssueStatusFromStep(tx, {
        workspaceId: fixture.workspace.id,
        stepId: step.id,
        actorId: fixture.user.id,
      });
    });
    expect(await category()).toBe("IN_REVIEW");

    await prisma.$transaction(async (tx) => {
      await tx.executionStep.update({
        where: { id: step.id },
        data: { status: ExecutionStepStatus.DONE },
      });
      await syncMaterializedIssueStatusFromStep(tx, {
        workspaceId: fixture.workspace.id,
        stepId: step.id,
        actorId: fixture.user.id,
      });
    });
    expect(await category()).toBe("DONE");
  });

  it("feeds an operator DONE transition back into the step and unlocks its dependent", async () => {
    const { fixture, prisma } = await setup();
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Operator completion plan",
      steps: [{ title: "Root" }, { title: "Child", dependsOnStepIndexes: [0] }],
    });
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.RUNNING },
    });
    const steps = await prisma.executionStep.findMany({
      where: { planId },
      orderBy: { position: "asc" },
    });
    await prisma.executionStep.update({
      where: { id: steps[0]!.id },
      data: { status: ExecutionStepStatus.RUNNING },
    });
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: steps[0]!.id,
    });
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });

    await prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data: { statusId: done.id } });
      await recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issueId,
        action: "operator-complete",
        eventKind: EventKind.ISSUE_STATUS_CHANGED,
        subjectType: "issue",
        subjectId: issueId,
        payload: { statusId: done.id },
      });
    });

    const after = await prisma.executionStep.findMany({
      where: { planId },
      orderBy: { position: "asc" },
    });
    expect(after[0]!.status).toBe(ExecutionStepStatus.DONE);
    expect(after[1]!.status).toBe(ExecutionStepStatus.READY);
  });

  it("cancels the one linked step and blocks its running plan", async () => {
    const { fixture, prisma } = await setup();
    const { id: planId } = await createExecutionPlan(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      title: "Operator cancellation plan",
      steps: [{ title: "Required work" }],
    });
    await prisma.executionPlan.update({
      where: { id: planId },
      data: { status: ExecutionPlanStatus.RUNNING },
    });
    const step = await prisma.executionStep.findFirstOrThrow({ where: { planId } });
    await prisma.executionStep.update({
      where: { id: step.id },
      data: { status: ExecutionStepStatus.RUNNING },
    });
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: step.id,
    });
    const canceled = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "CANCELED" },
    });

    await prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data: { statusId: canceled.id } });
      await recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issueId,
        action: "operator-cancel",
        eventKind: EventKind.ISSUE_STATUS_CHANGED,
        subjectType: "issue",
        subjectId: issueId,
        payload: { statusId: canceled.id },
      });
    });

    expect((await prisma.executionStep.findUniqueOrThrow({ where: { id: step.id } })).status).toBe(
      ExecutionStepStatus.CANCELED,
    );
    expect((await prisma.executionPlan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      ExecutionPlanStatus.BLOCKED,
    );
  });

  it("refills another crew plan after an operator cancels the running materialized step", async () => {
    const { fixture, prisma } = await setup();
    const worker = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `sync-worker-${Math.random().toString(36).slice(2, 8)}`,
        name: "Sync Worker",
      },
    });
    const crew = await createAgentCrew(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      name: "Shared sync crew",
      maxParallel: 1,
      members: [{ agentId: worker.id, role: "WORKER" }],
    });
    const [activePlan, queuedPlan] = await Promise.all(
      ["Active operator plan", "Queued operator plan"].map((title) =>
        prisma.executionPlan.create({
          data: {
            workspaceId: fixture.workspace.id,
            title,
            crewId: crew.id,
            status: ExecutionPlanStatus.RUNNING,
            startedAt: new Date(),
            steps: {
              create: {
                workspaceId: fixture.workspace.id,
                title: title.startsWith("Active") ? "Cancelable work" : "Waiting work",
                position: 0,
              },
            },
          },
        }),
      ),
    );
    const activePlanId = activePlan.id;
    const queuedPlanId = queuedPlan.id;
    const activeStep = await prisma.executionStep.findFirstOrThrow({
      where: { planId: activePlanId },
    });
    const queuedStep = await prisma.executionStep.findFirstOrThrow({
      where: { planId: queuedPlanId },
    });
    await prisma.executionStep.update({
      where: { id: activeStep.id },
      data: { status: ExecutionStepStatus.RUNNING, assignedAgentId: worker.id },
    });
    const { issueId } = await materializeStepAsIssue(prisma, {
      workspaceId: fixture.workspace.id,
      actorId: fixture.user.id,
      stepId: activeStep.id,
    });
    const canceled = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "CANCELED" },
    });

    await prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data: { statusId: canceled.id } });
      await recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issueId,
        action: "operator-cancel",
        eventKind: EventKind.ISSUE_STATUS_CHANGED,
        subjectType: "issue",
        subjectId: issueId,
        payload: { statusId: canceled.id },
      });
    });

    expect(
      (await prisma.executionPlan.findUniqueOrThrow({ where: { id: activePlanId } })).status,
    ).toBe(ExecutionPlanStatus.BLOCKED);
    expect(
      (await prisma.executionStep.findUniqueOrThrow({ where: { id: activeStep.id } })).status,
    ).toBe(ExecutionStepStatus.CANCELED);
    expect(
      (await prisma.executionStep.findUniqueOrThrow({ where: { id: queuedStep.id } })).status,
    ).toBe(ExecutionStepStatus.READY);
  });
});
