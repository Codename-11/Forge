import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProjectAccessRole, ProjectVisibility } from "@prisma/client";
import { composeStandup } from "@/server/services/standup";
import {
  createIssue,
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

describe("standup project access", () => {
  it("excludes restricted authored and assigned work after revocation", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SUP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PRIVATE",
        name: "Private",
        visibility: ProjectVisibility.RESTRICTED,
        createdById: fixture.user.id,
      },
    });
    const issue = await createIssue(fixture, {
      projectId: project.id,
      title: "Private standup work",
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { authorId: fixture.secondUser.id, completedAt: new Date() },
    });
    const draft = () =>
      composeStandup({
        workspaceId: fixture.workspace.id,
        userId: fixture.secondUser.id,
        sinceHours: 24,
      });

    expect((await draft()).groups.closed).toEqual([]);
    const grant = await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        membershipId: membership.id,
        role: ProjectAccessRole.VIEWER,
        grantedById: fixture.user.id,
      },
    });
    expect((await draft()).groups.closed.map((row) => row.id)).toEqual([issue.id]);
    await prisma.projectAccess.delete({ where: { id: grant.id } });
    expect((await draft()).counts.closed).toBe(0);
  });
});
