import { describe, it, expect, afterAll, afterEach } from "vitest";
import { initiativeRouter } from "@/server/routers/initiative";
import {
  createWorkspaceFixture,
  buildContext,
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "INI" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = initiativeRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("initiativeRouter", () => {
  it("auto-generates a slug from the name", async () => {
    const { caller } = await setup();
    const i = await caller.create({ name: "  Platform  V2!  " });
    expect(i.slug).toBe("platform-v2");
  });

  it("reject duplicate slugs in the same workspace", async () => {
    const { caller } = await setup();
    await caller.create({ name: "Analytics", slug: "analytics" });
    await expect(caller.create({ name: "Analytics", slug: "analytics" })).rejects.toThrow();
  });

  it("reorder() sets positions to array index and list returns them sorted", async () => {
    const { caller } = await setup();
    const a = await caller.create({ name: "A" });
    const b = await caller.create({ name: "B" });
    const c = await caller.create({ name: "C" });

    await caller.reorder({ ids: [c.id, a.id, b.id] });
    const list = await caller.list();
    expect(list.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    expect(list[0].position).toBe(0);
    expect(list[2].position).toBe(2);
  });

  it("linkProject() attaches and get() includes projects", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const initiative = await caller.create({ name: "Ship It" });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PRJ",
        name: "Project",
        createdById: fixture.user.id,
      },
    });

    await caller.linkProject({ initiativeId: initiative.id, projectId: project.id });
    const got = await caller.get({ id: initiative.id });
    expect(got.projects.map((p) => p.id)).toContain(project.id);

    await caller.unlinkProject({ projectId: project.id });
    const after = await caller.get({ id: initiative.id });
    expect(after.projects.map((p) => p.id)).not.toContain(project.id);
  });

  it("archive() sets status to COMPLETED", async () => {
    const { caller } = await setup();
    const i = await caller.create({ name: "Wrap" });
    const after = await caller.archive({ id: i.id });
    expect(after.status).toBe("COMPLETED");
  });
});
