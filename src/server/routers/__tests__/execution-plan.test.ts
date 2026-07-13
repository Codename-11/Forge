import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AgentRunStatus,
  EventKind,
  ExecutionPlanStatus,
  ExecutionStepStatus,
} from "@prisma/client";
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

  it("rejects cross-workspace step assignees across create, add, and update", async () => {
    const { fixture, caller } = await setup();
    const foreign = await createWorkspaceFixture({ keyPrefix: "EXF" });
    fixtures.push(foreign);
    const prisma = getPrisma();
    const foreignAgent = await prisma.agent.create({
      data: {
        workspaceId: foreign.workspace.id,
        profileKey: `foreign-${Date.now().toString(36)}`,
        name: "Foreign agent",
      },
    });

    await expect(
      caller.create({
        title: "Invalid plan",
        steps: [{ title: "Invalid step", assignedAgentId: foreignAgent.id }],
      }),
    ).rejects.toThrow(/not active agents in this workspace/);

    const plan = await caller.create({ title: "Valid plan", steps: [{ title: "Root" }] });
    await expect(
      caller.addStep({
        planId: plan.id,
        title: "Invalid child",
        assignedUserId: foreign.user.id,
      }),
    ).rejects.toThrow(/not members of this workspace/);

    const root = (await caller.get({ id: plan.id })).steps[0];
    await expect(
      caller.updateStep({ id: root.id, assignedAgentId: foreignAgent.id }),
    ).rejects.toThrow(/not active agents in this workspace/);

    expect(await prisma.executionStep.count({ where: { workspaceId: fixture.workspace.id } })).toBe(
      1,
    );
  });

  it("rejects foreign, self, and cyclic dependencies instead of storing them", async () => {
    const { caller } = await setup();
    const otherPlan = await caller.create({ title: "Other", steps: [{ title: "Foreign" }] });
    const foreignStep = (await caller.get({ id: otherPlan.id })).steps[0];
    const plan = await caller.create({
      title: "DAG",
      steps: [{ title: "A" }, { title: "B", dependsOnStepIndexes: [0] }],
    });
    const [a, b] = (await caller.get({ id: plan.id })).steps;

    await expect(
      caller.addStep({ planId: plan.id, title: "Bad", dependsOnStepIds: [foreignStep.id] }),
    ).rejects.toThrow(/same execution plan/);
    await expect(caller.updateStep({ id: a.id, dependsOnStepIds: [a.id] })).rejects.toThrow(
      /cannot depend on itself/,
    );
    await expect(caller.updateStep({ id: a.id, dependsOnStepIds: [b.id] })).rejects.toThrow(
      /dependency cycle/,
    );

    const unchanged = await caller.get({ id: plan.id });
    expect(unchanged.steps[0].dependsOnStepIds).toEqual([]);
    expect(unchanged.steps[1].dependsOnStepIds).toEqual([a.id]);
  });

  it("rejects invalid create indexes, foreign source runs, and direct admission states", async () => {
    const { caller } = await setup();
    await expect(
      caller.create({
        title: "Self dependency",
        steps: [{ title: "A", dependsOnStepIndexes: [0] }],
      }),
    ).rejects.toThrow(/cannot depend on itself/);
    await expect(
      caller.create({ title: "Bad index", steps: [{ title: "A", dependsOnStepIndexes: [1] }] }),
    ).rejects.toThrow(/out of range/);

    const foreign = await createWorkspaceFixture({ keyPrefix: "EXR" });
    fixtures.push(foreign);
    const prisma = getPrisma();
    const foreignIssue = await createIssue(foreign);
    const foreignAgent = await prisma.agent.create({
      data: {
        workspaceId: foreign.workspace.id,
        profileKey: `run-${Date.now().toString(36)}`,
        name: "Run agent",
      },
    });
    const foreignRun = await prisma.agentRun.create({
      data: {
        workspaceId: foreign.workspace.id,
        issueId: foreignIssue.id,
        agentId: foreignAgent.id,
      },
    });
    const plan = await caller.create({ title: "Plan", steps: [{ title: "Step" }] });
    const step = (await caller.get({ id: plan.id })).steps[0];

    await expect(caller.updateStep({ id: step.id, sourceRunId: foreignRun.id })).rejects.toThrow(
      /agent run in this workspace/,
    );
    await expect(
      caller.updateStep({ id: step.id, status: ExecutionStepStatus.READY }),
    ).rejects.toThrow(/orchestration-owned states/);
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

  it("lets an operator start agent review and record a human verdict", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const reviewer = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `reviewer-${Date.now().toString(36)}`,
        name: "Plan Reviewer",
      },
    });
    const crew = await prisma.agentCrew.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: `Review crew ${Date.now()}`,
        members: {
          create: {
            workspaceId: fixture.workspace.id,
            agentId: reviewer.id,
            role: "REVIEWER",
          },
        },
      },
    });
    const plan = await caller.create({
      title: "Review plan",
      steps: [{ title: "Review this" }],
    });
    const got = await caller.get({ id: plan.id });
    await prisma.executionPlan.update({
      where: { id: plan.id },
      data: { status: ExecutionPlanStatus.RUNNING, crewId: crew.id, startedAt: new Date() },
    });
    await prisma.executionStep.update({
      where: { id: got.steps[0].id },
      data: { status: ExecutionStepStatus.REVIEW },
    });

    const requested = await caller.requestReview({ stepId: got.steps[0].id });
    expect(requested.judgeAgentId).toBe(reviewer.id);
    expect(requested.runId).toBeTruthy();

    await caller.reviewStep({
      stepId: got.steps[0].id,
      verdict: "PASS",
      feedback: "Human verified the result.",
    });
    const step = await prisma.executionStep.findUniqueOrThrow({
      where: { id: got.steps[0].id },
    });
    expect(step.status).toBe(ExecutionStepStatus.DONE);
    const reviewRun = await prisma.agentRun.findUniqueOrThrow({
      where: { id: requested.runId! },
    });
    expect(reviewRun.status).toBe(AgentRunStatus.ABANDONED);
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

  it("refuses destructive or structural step edits on a live plan", async () => {
    const { caller } = await setup();
    const plan = await caller.create({
      title: "Live guarded plan",
      steps: [{ title: "Live root" }],
    });
    const draft = await caller.get({ id: plan.id });
    await caller.activate({ id: plan.id });

    await expect(caller.archive({ id: plan.id })).rejects.toThrow(
      /Cancel or complete this plan before archiving/,
    );
    await expect(caller.delete({ id: plan.id, confirm: "Live guarded plan" })).rejects.toThrow(
      /Cancel or complete this plan before deleting/,
    );
    await expect(caller.removeStep({ id: draft.steps[0].id })).rejects.toThrow(
      /only be removed while the plan is a draft/,
    );
    await expect(caller.addStep({ planId: plan.id, title: "Late addition" })).rejects.toThrow(
      /only be added while the execution plan is a draft/,
    );
    await expect(
      caller.updateStep({ id: draft.steps[0].id, dependsOnStepIds: [] }),
    ).rejects.toThrow(/dependencies can only be edited while the execution plan is a draft/);

    const after = await caller.get({ id: plan.id });
    expect(after.archivedAt).toBeNull();
    expect(after.steps).toHaveLength(1);
  });

  it("preserves draft dependency integrity when removing steps", async () => {
    const { caller } = await setup();
    const plan = await caller.create({
      title: "Dependency guarded plan",
      steps: [
        { title: "Root" },
        { title: "Child", dependsOnStepIndexes: [0] },
        { title: "Independent leaf" },
      ],
    });
    const draft = await caller.get({ id: plan.id });

    await expect(caller.removeStep({ id: draft.steps[0].id })).rejects.toThrow(
      /Remove the dependency from "Child"/,
    );
    await caller.removeStep({ id: draft.steps[2].id });

    const after = await caller.get({ id: plan.id });
    expect(after.steps.map((step) => step.title)).toEqual(["Root", "Child"]);
  });

  it("archives a settled plan with an observable change", async () => {
    const { fixture, caller } = await setup();
    const plan = await caller.create({ title: "Archivable draft" });

    await caller.archive({ id: plan.id });

    const row = await getPrisma().executionPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.archivedAt).not.toBeNull();
    const event = await getPrisma().activityEvent.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "execution-plan",
        subjectId: plan.id,
        kind: EventKind.ISSUE_UPDATED,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(event?.payload).toMatchObject({ action: "archived" });
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
