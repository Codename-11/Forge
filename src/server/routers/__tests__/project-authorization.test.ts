import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Role } from "@prisma/client";
import { projectRouter } from "@/server/routers/project";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function fixture(keyPrefix: string) {
  const created = await createWorkspaceFixture({ keyPrefix });
  fixtures.push(created);
  return created;
}

describe("project mutation authorization", () => {
  it("rejects project mutations from guests", async () => {
    const setup = await fixture("PGA");
    const prisma = getPrisma();
    await prisma.membership.update({
      where: {
        userId_workspaceId: {
          userId: setup.secondUser.id,
          workspaceId: setup.workspace.id,
        },
      },
      data: { role: Role.GUEST },
    });
    const owner = projectRouter.createCaller(await buildContext(setup));
    const guest = projectRouter.createCaller(
      await buildContext(setup, { asUserId: setup.secondUser.id }),
    );
    const project = await owner.create({ key: "AUTH", name: "Authorization" });

    await expect(guest.create({ key: "NOPE", name: "Forbidden" })).rejects.toThrow(
      /workspace role/i,
    );
    await expect(guest.update({ id: project.id, name: "Forbidden" })).rejects.toThrow(
      /workspace role/i,
    );
    await expect(guest.archive({ id: project.id })).rejects.toThrow(/workspace role/i);
    await expect(guest.softDelete({ id: project.id })).rejects.toThrow(/workspace role/i);

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchanged).toMatchObject({ name: "Authorization", archived: false, deletedAt: null });
  });

  it("preserves project mutation access for members", async () => {
    const setup = await fixture("PMA");
    const member = projectRouter.createCaller(
      await buildContext(setup, { asUserId: setup.secondUser.id }),
    );

    const project = await member.create({ key: "MEM", name: "Member project" });
    await expect(
      member.update({ id: project.id, name: "Updated by member" }),
    ).resolves.toMatchObject({ name: "Updated by member" });
  });

  it("does not archive a project from another workspace", async () => {
    const ownerSetup = await fixture("POW");
    const outsiderSetup = await fixture("POX");
    const owner = projectRouter.createCaller(await buildContext(ownerSetup));
    const outsider = projectRouter.createCaller(await buildContext(outsiderSetup));
    const project = await owner.create({ key: "SAFE", name: "Tenant boundary" });

    await expect(outsider.archive({ id: project.id })).rejects.toThrow();
    expect(
      await getPrisma().project.findUniqueOrThrow({ where: { id: project.id } }),
    ).toMatchObject({ archived: false, workspaceId: ownerSetup.workspace.id });
  });
});
