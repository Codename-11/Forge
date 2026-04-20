import { describe, it, expect, afterAll, afterEach } from "vitest";
import { CycleStatus } from "@prisma/client";
import { cycleRouter } from "@/server/routers/cycle";
import {
  createWorkspaceFixture,
  buildContext,
  createIssue,
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "CYC" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = cycleRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("cycleRouter", () => {
  it("creates with workspace defaults and retrieves", async () => {
    const { caller, fixture } = await setup();
    const cycle = await caller.create({ name: "Sprint 1" });
    expect(cycle.lengthDays).toBe(fixture.workspace.cycleLengthDays);
    expect(cycle.workspaceId).toBe(fixture.workspace.id);
    expect(cycle.endsAt.getTime()).toBeGreaterThan(cycle.startsAt.getTime());

    const got = await caller.get({ id: cycle.id });
    expect(got.id).toBe(cycle.id);
  });

  it("honors explicit lengthDays + startsAt", async () => {
    const { caller } = await setup();
    const startsAt = new Date("2026-01-01T00:00:00Z");
    const cycle = await caller.create({ name: "Custom", startsAt, lengthDays: 14 });
    expect(cycle.lengthDays).toBe(14);
    expect(cycle.startsAt.toISOString()).toBe(startsAt.toISOString());
    const diff = cycle.endsAt.getTime() - cycle.startsAt.getTime();
    expect(diff / (1000 * 60 * 60 * 24)).toBeCloseTo(14, 0);
  });

  it("current() returns the single ACTIVE cycle or null", async () => {
    const { caller } = await setup();
    expect(await caller.current()).toBeNull();
    const created = await caller.create({ name: "Active" });
    await caller.update({ id: created.id, status: CycleStatus.ACTIVE });
    const current = await caller.current();
    expect(current?.id).toBe(created.id);
  });

  it("plan() bulk-assigns issues and records audit events", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const cycle = await caller.create({ name: "Planning" });
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const res = await caller.plan({ cycleId: cycle.id, issueIds: [a.id, b.id] });
    expect(res.planned).toBe(2);

    const moved = await prisma.issue.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { cycleId: true },
    });
    expect(moved.every((i) => i.cycleId === cycle.id)).toBe(true);

    const events = await prisma.activityEvent.findMany({
      where: { workspaceId: fixture.workspace.id, subjectType: "issue" },
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("rollover() moves unfinished issues to a new ACTIVE cycle and verifies counts", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const cycle = await caller.create({ name: "Old" });
    await caller.update({ id: cycle.id, status: CycleStatus.ACTIVE });

    const ongoing = await createIssue(fixture, { title: "ongoing", statusCategory: "IN_PROGRESS" });
    const todo = await createIssue(fixture, { title: "todo", statusCategory: "TODO" });
    const done = await createIssue(fixture, { title: "done", statusCategory: "DONE" });
    const canceled = await createIssue(fixture, { title: "canceled", statusCategory: "CANCELED" });

    await caller.plan({
      cycleId: cycle.id,
      issueIds: [ongoing.id, todo.id, done.id, canceled.id],
    });

    const res = await caller.rollover({ fromCycleId: cycle.id });
    expect(res.rolled).toBe(2);
    expect(res.targetCycleId).not.toBe(cycle.id);

    const rolled = await prisma.issue.findMany({
      where: { id: { in: [ongoing.id, todo.id] } },
      select: { id: true, cycleId: true },
    });
    expect(rolled.every((i) => i.cycleId === res.targetCycleId)).toBe(true);

    const stayed = await prisma.issue.findMany({
      where: { id: { in: [done.id, canceled.id] } },
      select: { id: true, cycleId: true },
    });
    expect(stayed.every((i) => i.cycleId === cycle.id)).toBe(true);
  });

  it("archive() sets status to COMPLETED", async () => {
    const { caller } = await setup();
    const cycle = await caller.create({ name: "to-archive" });
    const after = await caller.archive({ id: cycle.id });
    expect(after.status).toBe(CycleStatus.COMPLETED);
  });

  it("list() respects status filter", async () => {
    const { caller } = await setup();
    const a = await caller.create({ name: "a" });
    const b = await caller.create({ name: "b" });
    await caller.update({ id: b.id, status: CycleStatus.ACTIVE });
    const planned = await caller.list({ status: CycleStatus.PLANNED });
    expect(planned.map((c) => c.id)).toContain(a.id);
    expect(planned.map((c) => c.id)).not.toContain(b.id);
  });
});
