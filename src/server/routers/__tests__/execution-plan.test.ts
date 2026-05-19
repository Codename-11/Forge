import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ExecutionPlanStatus, ExecutionStepStatus } from "@prisma/client";
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
        { title: "Apply + verify", expectedOutput: "All tests green" },
      ],
    });
    const got = await caller.get({ id: created.id });
    expect(got.steps).toHaveLength(2);
    expect(got.steps[0].title).toBe("Write migration");
    expect(got.steps[0].position).toBe(0);
    expect(got.steps[1].position).toBe(1);
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
