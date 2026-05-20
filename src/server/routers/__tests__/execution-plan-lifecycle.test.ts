import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ExecutionPlanStatus, Role } from "@prisma/client";
import { executionPlanRouter } from "@/server/routers/execution-plan";
import {
  buildContext,
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "EXL" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = executionPlanRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("executionPlanRouter — restore", () => {
  it("clears archivedAt and emits an audit log", async () => {
    const { fixture, caller } = await setup();
    const plan = await caller.create({ title: "Restore me" });
    await caller.archive({ id: plan.id });
    let row = await getPrisma().executionPlan.findUniqueOrThrow({
      where: { id: plan.id },
    });
    expect(row.archivedAt).not.toBeNull();

    await caller.restore({ id: plan.id });
    row = await getPrisma().executionPlan.findUniqueOrThrow({
      where: { id: plan.id },
    });
    expect(row.archivedAt).toBeNull();

    const audit = await getPrisma().auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "execution-plan",
        entityId: plan.id,
        action: "restore",
      },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects restore for a plan in another workspace", async () => {
    const { caller: callerA } = await setup();
    const { caller: callerB } = await setup();
    const planB = await callerB.create({ title: "Theirs" });
    await callerB.archive({ id: planB.id });
    await expect(callerA.restore({ id: planB.id })).rejects.toThrow(
      /Execution plan not found/,
    );
  });

  it("is a no-op if the plan is not archived", async () => {
    const { caller } = await setup();
    const plan = await caller.create({ title: "Not archived" });
    await expect(caller.restore({ id: plan.id })).resolves.toEqual({ ok: true });
  });
});

describe("executionPlanRouter — duplicate", () => {
  it("clones a plan with stable step positions and remapped depends-on", async () => {
    const { caller } = await setup();
    const created = await caller.create({
      title: "Build feature X",
      description: "Three-step chain.",
      steps: [
        { title: "Investigate" },
        { title: "Design" },
        { title: "Implement" },
      ],
    });
    const source = await caller.get({ id: created.id });
    // Wire deps: Design depends on Investigate; Implement depends on Design.
    await caller.updateStep({
      id: source.steps[1].id,
      dependsOnStepIds: [source.steps[0].id],
    });
    await caller.updateStep({
      id: source.steps[2].id,
      dependsOnStepIds: [source.steps[1].id],
    });

    const cloned = await caller.duplicate({ id: created.id });
    const got = await caller.get({ id: cloned.id });

    expect(got.id).not.toBe(created.id);
    expect(got.title).toBe("Copy of Build feature X");
    expect(got.description).toBe("Three-step chain.");
    expect(got.status).toBe(ExecutionPlanStatus.DRAFT);
    expect(got.steps).toHaveLength(3);
    expect(got.steps.map((s) => s.title)).toEqual([
      "Investigate",
      "Design",
      "Implement",
    ]);
    expect(got.steps.map((s) => s.position)).toEqual([0, 1, 2]);

    // dependsOnStepIds must point at the NEW step ids, not the source ones.
    const newInvestigate = got.steps[0].id;
    const newDesign = got.steps[1].id;
    expect(got.steps[0].dependsOnStepIds).toEqual([]);
    expect(got.steps[1].dependsOnStepIds).toEqual([newInvestigate]);
    expect(got.steps[2].dependsOnStepIds).toEqual([newDesign]);
    // Sanity: none of the new deps leak the original step ids.
    const sourceStepIds = new Set(source.steps.map((s) => s.id));
    for (const step of got.steps) {
      for (const dep of step.dependsOnStepIds) {
        expect(sourceStepIds.has(dep)).toBe(false);
      }
    }
  });

  it("uses the provided newTitle when supplied", async () => {
    const { caller } = await setup();
    const created = await caller.create({ title: "Original" });
    const cloned = await caller.duplicate({ id: created.id, newTitle: "Renamed copy" });
    const got = await caller.get({ id: cloned.id });
    expect(got.title).toBe("Renamed copy");
  });
});

describe("executionPlanRouter — delete", () => {
  it("hard-deletes the plan and cascades to its steps when confirm matches", async () => {
    const { caller } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({
      title: "Delete me",
      steps: [{ title: "Only step" }],
    });
    const before = await caller.get({ id: created.id });
    expect(before.steps).toHaveLength(1);

    await caller.delete({ id: created.id, confirm: "Delete me" });

    const planRow = await prisma.executionPlan.findUnique({
      where: { id: created.id },
    });
    expect(planRow).toBeNull();
    const stepRow = await prisma.executionStep.findUnique({
      where: { id: before.steps[0].id },
    });
    expect(stepRow).toBeNull();
  });

  it("rejects delete when confirm does not match", async () => {
    const { caller } = await setup();
    const created = await caller.create({ title: "Exact title" });
    await expect(
      caller.delete({ id: created.id, confirm: "Wrong" }),
    ).rejects.toThrow(/Confirmation text/);
  });

  it("rejects delete by a non-admin member", async () => {
    const { fixture, caller } = await setup();
    const plan = await caller.create({ title: "Doomed" });

    // secondUser is MEMBER by default — drive the delete as them.
    const memberCtx = await buildContext(fixture, {
      asUserId: fixture.secondUser.id,
    });
    const memberCaller = executionPlanRouter.createCaller(memberCtx);
    await expect(
      memberCaller.delete({ id: plan.id, confirm: "Doomed" }),
    ).rejects.toThrow(/Admin role required/);
  });

  it("allows delete by a workspace admin", async () => {
    const { fixture, caller } = await setup();
    const plan = await caller.create({ title: "Admin-deletable" });
    // Promote secondUser to ADMIN.
    await getPrisma().membership.update({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
      data: { role: Role.ADMIN },
    });
    const adminCtx = await buildContext(fixture, {
      asUserId: fixture.secondUser.id,
    });
    const adminCaller = executionPlanRouter.createCaller(adminCtx);
    await adminCaller.delete({ id: plan.id, confirm: "Admin-deletable" });
    const row = await getPrisma().executionPlan.findUnique({
      where: { id: plan.id },
    });
    expect(row).toBeNull();
  });
});

describe("executionPlanRouter — list archived", () => {
  it("returns only archived rows when archivedOnly is true", async () => {
    const { caller } = await setup();
    const alive = await caller.create({ title: "Alive" });
    const dead = await caller.create({ title: "Dead" });
    await caller.archive({ id: dead.id });

    const active = await caller.list({});
    expect(active.items.find((r) => r.id === alive.id)).toBeTruthy();
    expect(active.items.find((r) => r.id === dead.id)).toBeUndefined();

    const archived = await caller.list({ archivedOnly: true });
    expect(archived.items.find((r) => r.id === dead.id)).toBeTruthy();
    expect(archived.items.find((r) => r.id === alive.id)).toBeUndefined();
  });
});
