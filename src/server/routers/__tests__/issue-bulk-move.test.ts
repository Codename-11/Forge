import { describe, it, expect, afterAll, afterEach } from "vitest";
import { issueRouter } from "@/server/routers/issue";
import {
  createWorkspaceFixture,
  buildContext,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Coverage for moving issues between projects / sprints — the single
 * `issue.update({ cycleId })` path and the `bulkSetProject` /
 * `bulkSetCycle` bulk mutations behind the list + inbox bulk bars.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "MOV" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = issueRouter.createCaller(ctx);
  const prisma = getPrisma();
  const project = await prisma.project.create({
    data: {
      workspaceId: fixture.workspace.id,
      key: "PRJ",
      name: "Target Project",
      createdById: fixture.user.id,
    },
  });
  const cycle = await prisma.cycle.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Sprint 1",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 7 * 86_400_000),
      lengthDays: 7,
    },
  });
  return { fixture, ctx, caller, prisma, project, cycle };
}

describe("issueRouter — project / sprint moves", () => {
  it("issue.update sets and clears cycleId", async () => {
    const { caller, fixture, prisma, cycle } = await setup();
    const issue = await createIssue(fixture);

    await caller.update({ id: issue.id, cycleId: cycle.id });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).cycleId).toBe(cycle.id);

    await caller.update({ id: issue.id, cycleId: null });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).cycleId).toBeNull();
  });

  it("issue.update rejects a cycle from another workspace", async () => {
    const { caller, fixture } = await setup();
    const issue = await createIssue(fixture);
    const other = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(other);
    const foreignCycle = await getPrisma().cycle.create({
      data: {
        workspaceId: other.workspace.id,
        name: "Foreign",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 7 * 86_400_000),
        lengthDays: 7,
      },
    });
    await expect(caller.update({ id: issue.id, cycleId: foreignCycle.id })).rejects.toThrow();
  });

  it("bulkSetProject moves the selection and reports the count", async () => {
    const { caller, fixture, prisma, project } = await setup();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const res = await caller.bulkSetProject({ issueIds: [a.id, b.id], projectId: project.id });
    expect(res.updated).toBe(2);
    const rows = await prisma.issue.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((r) => r.projectId === project.id)).toBe(true);

    // Clearing the project sets it back to null.
    await caller.bulkSetProject({ issueIds: [a.id], projectId: null });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: a.id } })).projectId).toBeNull();
  });

  it("bulkSetCycle moves the selection into a sprint", async () => {
    const { caller, fixture, prisma, cycle } = await setup();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const res = await caller.bulkSetCycle({ issueIds: [a.id, b.id], cycleId: cycle.id });
    expect(res.updated).toBe(2);
    const rows = await prisma.issue.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((r) => r.cycleId === cycle.id)).toBe(true);
  });

  it("bulk moves reject a target from another workspace", async () => {
    const { caller, fixture } = await setup();
    const issue = await createIssue(fixture);
    const other = await createWorkspaceFixture({ keyPrefix: "OT2" });
    fixtures.push(other);
    const foreignProject = await getPrisma().project.create({
      data: {
        workspaceId: other.workspace.id,
        key: "FGN",
        name: "Foreign",
        createdById: other.user.id,
      },
    });
    await expect(
      caller.bulkSetProject({ issueIds: [issue.id], projectId: foreignProject.id }),
    ).rejects.toThrow();
  });
});
