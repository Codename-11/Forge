import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentRunStatus, ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
import { executionPlanRouter } from "@/server/routers/execution-plan";
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
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "EXE" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = executionPlanRouter.createCaller(ctx);
  return { fixture, caller };
}

describe("executionPlanRouter", () => {
  it("creates a plan with ordered steps", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({
      title: "Auth migration plan",
      description: "Spec → implement → verify.",
      issueId: issue.id,
      steps: [
        { title: "Write migration", expectedOutput: "SQL committed" },
        { title: "Apply + verify", expectedOutput: "All tests green", dependsOnStepIndexes: [0] },
      ],
    });
    const got = await caller.get({ id: created.id });
    expect(got.steps).toHaveLength(2);
    expect(got.steps[0].title).toBe("Write migration");
    expect(got.steps[0].position).toBe(0);
    expect(got.steps[1].position).toBe(1);
    expect(got.steps[1].dependsOnStepIds).toEqual([got.steps[0].id]);
    expect(got.status).toBe(ExecutionPlanStatus.DRAFT);
  });

  it("appends a step at the next position", async () => {
    const { caller } = await setup();
    const created = await caller.create({
      title: "Plan",
      steps: [{ title: "First" }],
    });
    const step = await caller.addStep({ planId: created.id, title: "Second" });
    const got = await caller.get({ id: created.id });
    expect(got.steps).toHaveLength(2);
    expect(got.steps.find((s) => s.id === step.id)?.position).toBe(1);
  });

  it("transitions a plan from DRAFT to APPROVED to RUNNING", async () => {
    const { caller } = await setup();
    const plan = await caller.create({ title: "Plan" });
    await caller.update({ id: plan.id, status: ExecutionPlanStatus.APPROVED });
    await caller.update({ id: plan.id, status: ExecutionPlanStatus.RUNNING });
    const got = await caller.get({ id: plan.id });
    expect(got.status).toBe(ExecutionPlanStatus.RUNNING);
  });

  it("activates a draft plan and readies root steps", async () => {
    const { caller } = await setup();
    const plan = await caller.create({
      title: "Plan",
      steps: [{ title: "Root" }, { title: "Child", dependsOnStepIndexes: [0] }],
    });

    await caller.activate({ id: plan.id });

    const got = await caller.get({ id: plan.id });
    expect(got.status).toBe(ExecutionPlanStatus.RUNNING);
    expect(got.steps[0].status).toBe(ExecutionStepStatus.READY);
    expect(got.steps[1].status).toBe(ExecutionStepStatus.TODO);
  });

  it("retries a stalled step with a fresh step-bound run", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Step issue" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `retry-${Date.now().toString(36)}`,
        name: "Retry Worker",
      },
    });
    const plan = await caller.create({
      title: "Retry plan",
      issueId: issue.id,
      steps: [{ title: "Run once", assignedAgentId: agent.id }],
    });
    await caller.activate({ id: plan.id });
    const got = await caller.get({ id: plan.id });
    const step = got.steps[0];
    const firstRun = await prisma.agentRun.findFirstOrThrow({
      where: { executionStepId: step.id },
    });
    await prisma.agentRun.update({
      where: { id: firstRun.id },
      data: {
        status: AgentRunStatus.STALLED,
        finishedAt: new Date(),
        summary: "Credential expired.",
      },
    });

    const retry = await caller.retryStep({ stepId: step.id });

    expect(retry.stepId).toBe(step.id);
    expect(retry.issueId).toBe(issue.id);
    expect(retry.agentId).toBe(agent.id);
    expect(retry.runId).not.toBe(firstRun.id);
    const runs = await prisma.agentRun.findMany({
      where: { executionStepId: step.id },
      orderBy: { startedAt: "asc" },
    });
    expect(runs.map((r) => r.status)).toEqual([AgentRunStatus.STALLED, AgentRunStatus.ACTIVE]);
    expect(runs[1].issueId).toBe(issue.id);

    const event = await prisma.activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "execution-step",
        subjectId: step.id,
        kind: "EXECUTION_STEP_READY",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(event?.payload).toMatchObject({ retry: true, stepId: step.id });
  });

  it("transitions a step to DONE and records audit", async () => {
    const { fixture, caller } = await setup();
    const created = await caller.create({
      title: "Plan",
      steps: [{ title: "Only step" }],
    });
    const got = await caller.get({ id: created.id });
    await caller.updateStep({
      id: got.steps[0].id,
      status: ExecutionStepStatus.DONE,
    });
    const after = await caller.get({ id: created.id });
    expect(after.steps[0].status).toBe(ExecutionStepStatus.DONE);

    const audit = await getPrisma().auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "execution-step",
        entityId: got.steps[0].id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("links plan to context set", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const set = await prisma.contextSet.create({
      data: { workspaceId: fixture.workspace.id, name: "Migration context" },
    });
    const plan = await caller.create({
      title: "Plan",
      contextSetId: set.id,
    });
    const got = await caller.get({ id: plan.id });
    expect(got.contextSet?.id).toBe(set.id);
  });
});

describe("executionPlanRouter — step comments", () => {
  async function setupWithStep() {
    const fixture = await createWorkspaceFixture({ keyPrefix: "EXS" });
    fixtures.push(fixture);
    const ctx = await buildContext(fixture);
    const caller = executionPlanRouter.createCaller(ctx);
    const plan = await caller.create({
      title: "Plan with steps",
      steps: [{ title: "Step one" }, { title: "Step two" }],
    });
    const full = await caller.get({ id: plan.id });
    return { fixture, ctx, caller, plan: full, step: full.steps[0] };
  }

  it("create + list happy path returns comments in chronological order", async () => {
    const { caller, step } = await setupWithStep();
    const first = await caller.stepCommentCreate({
      stepId: step.id,
      body: "First take on this step.",
    });
    // Force a tiny gap so createdAt ordering is deterministic on a
    // fast Postgres.
    await new Promise((r) => setTimeout(r, 5));
    const second = await caller.stepCommentCreate({
      stepId: step.id,
      body: "Follow-up after thinking it through.",
    });

    const got = await caller.stepCommentList({ stepId: step.id });
    expect(got.items).toHaveLength(2);
    expect(got.items[0].id).toBe(first.id);
    expect(got.items[1].id).toBe(second.id);
    expect(got.items[0].body).toBe("First take on this step.");
  });

  it("rejects steps from a different workspace", async () => {
    const { caller: callerA } = await setupWithStep();
    const { step: stepB } = await setupWithStep();
    // callerA is scoped to workspace A; stepB lives in workspace B.
    await expect(callerA.stepCommentCreate({ stepId: stepB.id, body: "hi" })).rejects.toThrow(
      /Execution step not found/,
    );
    await expect(callerA.stepCommentList({ stepId: stepB.id })).rejects.toThrow(
      /Execution step not found/,
    );
  });

  it("emits COMMENT_CREATED observable via ActivityEvent query", async () => {
    const { fixture, caller, step } = await setupWithStep();
    const created = await caller.stepCommentCreate({
      stepId: step.id,
      body: "An event-worthy comment.",
    });
    const event = await getPrisma().activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        kind: "COMMENT_CREATED",
        subjectType: "execution-step",
        subjectId: step.id,
      },
    });
    expect(event).not.toBeNull();
    const payload = event!.payload as { commentId?: string; planId?: string };
    expect(payload.commentId).toBe(created.id);
    expect(payload.planId).toBeTruthy();
  });

  it("materializes a step and opens a canonical run when an agent is mentioned", async () => {
    const { fixture, caller, step } = await setupWithStep();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `comment-agent-${Date.now()}`,
        name: "Comment Agent",
      },
    });

    await caller.stepCommentCreate({
      stepId: step.id,
      body: `@${agent.profileKey} please inspect the failed verification and respond here.`,
    });

    const updatedStep = await prisma.executionStep.findUniqueOrThrow({
      where: { id: step.id },
      select: { issueId: true },
    });
    expect(updatedStep.issueId).toBeTruthy();
    const run = await prisma.agentRun.findFirst({
      where: { executionStepId: step.id, agentId: agent.id },
      orderBy: { startedAt: "desc" },
    });
    expect(run).toMatchObject({
      issueId: updatedStep.issueId,
      triggerKind: "COMMENT_CREATED",
    });
    const event = await prisma.activityEvent.findUniqueOrThrow({
      where: { id: run!.triggerEventId! },
    });
    expect(event.payload).toMatchObject({
      executionStepId: step.id,
      body: expect.stringContaining("failed verification"),
    });
  });

  it("author can delete their own step comment (soft-delete)", async () => {
    const { caller, step } = await setupWithStep();
    const created = await caller.stepCommentCreate({
      stepId: step.id,
      body: "Going to retract this.",
    });
    await caller.stepCommentDelete({ commentId: created.id });
    const got = await caller.stepCommentList({ stepId: step.id });
    expect(got.items.find((c) => c.id === created.id)).toBeUndefined();

    // Soft-deleted row still exists in the table with deletedAt set —
    // important so audit history can still resolve it by id.
    const row = await getPrisma().comment.findUnique({
      where: { id: created.id },
    });
    expect(row?.deletedAt).not.toBeNull();
  });

  it("non-author non-admin cannot delete another user's step comment", async () => {
    const { fixture, step } = await setupWithStep();
    const authorCtx = await buildContext(fixture);
    const authorCaller = executionPlanRouter.createCaller(authorCtx);
    const created = await authorCaller.stepCommentCreate({
      stepId: step.id,
      body: "Author's comment.",
    });

    // Demote the second user to a plain MEMBER (createWorkspaceFixture
    // already sets MEMBER, but make it explicit here so the gate is
    // unambiguous), then drive the delete as them.
    await getPrisma().membership.update({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
      data: { role: "MEMBER" },
    });
    const otherCtx = await buildContext(fixture, {
      asUserId: fixture.secondUser.id,
    });
    const otherCaller = executionPlanRouter.createCaller(otherCtx);

    await expect(otherCaller.stepCommentDelete({ commentId: created.id })).rejects.toThrow(
      /author or a workspace admin/,
    );
  });

  it("workspace admin can delete another user's step comment", async () => {
    const { fixture, step } = await setupWithStep();
    const authorCtx = await buildContext(fixture, {
      asUserId: fixture.secondUser.id,
    });
    const authorCaller = executionPlanRouter.createCaller(authorCtx);
    const created = await authorCaller.stepCommentCreate({
      stepId: step.id,
      body: "Comment from a member.",
    });

    // The first user is the OWNER (per createWorkspaceFixture); owners
    // satisfy the admin gate.
    const adminCtx = await buildContext(fixture);
    const adminCaller = executionPlanRouter.createCaller(adminCtx);
    await adminCaller.stepCommentDelete({ commentId: created.id });

    const row = await getPrisma().comment.findUnique({
      where: { id: created.id },
    });
    expect(row?.deletedAt).not.toBeNull();
  });
});
