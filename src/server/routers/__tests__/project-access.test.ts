import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProjectAccessRole, ProjectVisibility, Role } from "@prisma/client";
import { projectRouter } from "@/server/routers/project";
import { projectAccessRouter } from "@/server/routers/project-access";
import { issueRouter } from "@/server/routers/issue";
import { commandPaletteRouter } from "@/server/routers/command-palette";
import { dashboardRouter } from "@/server/routers/dashboard";
import { globalRouter } from "@/server/routers/global";
import { inboxRouter } from "@/server/routers/inbox";
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
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(disconnectPrisma);

async function fixture(keyPrefix: string) {
  const created = await createWorkspaceFixture({ keyPrefix });
  fixtures.push(created);
  return created;
}

describe("restricted project access", () => {
  it("hides restricted projects until an explicit grant exists", async () => {
    const setup = await fixture("RPA");
    const owner = projectRouter.createCaller(await buildContext(setup));
    const member = projectRouter.createCaller(
      await buildContext(setup, { asUserId: setup.secondUser.id }),
    );
    const access = projectAccessRouter.createCaller(await buildContext(setup));
    const project = await owner.create({
      key: "LOCK",
      name: "Restricted",
      visibility: ProjectVisibility.RESTRICTED,
    });
    const membership = await getPrisma().membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: setup.secondUser.id,
          workspaceId: setup.workspace.id,
        },
      },
    });

    expect((await member.list()).items).toHaveLength(0);
    await expect(member.byId({ id: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await access.set({
      projectId: project.id,
      membershipId: membership.id,
      role: ProjectAccessRole.VIEWER,
    });
    expect((await member.list()).items.map((row) => row.id)).toEqual([project.id]);
    await expect(member.byId({ id: project.id })).resolves.toMatchObject({ id: project.id });
    await expect(member.update({ id: project.id, name: "No" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lets managers administer a project and audits grant changes", async () => {
    const setup = await fixture("RPM");
    const owner = projectRouter.createCaller(await buildContext(setup));
    const ownerAccess = projectAccessRouter.createCaller(await buildContext(setup));
    const member = projectRouter.createCaller(
      await buildContext(setup, { asUserId: setup.secondUser.id }),
    );
    const memberAccess = projectAccessRouter.createCaller(
      await buildContext(setup, { asUserId: setup.secondUser.id }),
    );
    const project = await owner.create({ key: "MGR", name: "Managed" });
    const membership = await getPrisma().membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: setup.secondUser.id,
          workspaceId: setup.workspace.id,
        },
      },
    });
    await ownerAccess.set({
      projectId: project.id,
      membershipId: membership.id,
      role: ProjectAccessRole.MANAGER,
    });

    await expect(
      member.update({ id: project.id, visibility: ProjectVisibility.RESTRICTED }),
    ).resolves.toMatchObject({ visibility: ProjectVisibility.RESTRICTED });
    const candidates = await memberAccess.candidates({ projectId: project.id });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          membershipId: membership.id,
          projectRole: ProjectAccessRole.MANAGER,
          inheritedAdmin: false,
          mutable: true,
        }),
        expect.objectContaining({
          workspaceRole: Role.OWNER,
          inheritedAdmin: true,
          mutable: false,
        }),
      ]),
    );
    expect(await memberAccess.list({ projectId: project.id })).toHaveLength(1);
    await memberAccess.remove({ projectId: project.id, membershipId: membership.id });

    const events = await getPrisma().activityEvent.findMany({
      where: {
        workspaceId: setup.workspace.id,
        subjectType: "project",
        subjectId: project.id,
        kind: "PROJECT_ACCESS_CHANGED",
      },
    });
    expect(events).toHaveLength(2);
    await expect(member.byId({ id: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects cross-tenant membership ids", async () => {
    const setup = await fixture("RPT");
    const other = await fixture("RPO");
    const owner = projectRouter.createCaller(await buildContext(setup));
    const access = projectAccessRouter.createCaller(await buildContext(setup));
    const project = await owner.create({ key: "SAFE", name: "Safe" });
    const foreignMembership = await getPrisma().membership.findFirstOrThrow({
      where: { workspaceId: other.workspace.id, userId: other.secondUser.id },
    });

    await expect(
      access.set({
        projectId: project.id,
        membershipId: foreignMembership.id,
        role: ProjectAccessRole.VIEWER,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await getPrisma().projectAccess.count({
        where: { workspaceId: setup.workspace.id, projectId: project.id },
      }),
    ).toBe(0);
  });

  it("keeps guests out of workspace-visible projects without an explicit grant", async () => {
    const setup = await fixture("RPG");
    await getPrisma().membership.update({
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
    await owner.create({ key: "OPEN", name: "Workspace visible" });
    expect((await guest.list()).items).toHaveLength(0);
  });

  it("filters issue lists and applies viewer/contributor roles to direct writes", async () => {
    const setup = await fixture("RPI");
    const ownerProjects = projectRouter.createCaller(await buildContext(setup));
    const ownerAccess = projectAccessRouter.createCaller(await buildContext(setup));
    const memberIssues = issueRouter.createCaller(
      await buildContext(setup, { asUserId: setup.secondUser.id }),
    );
    const project = await ownerProjects.create({
      key: "ISS",
      name: "Private issues",
      visibility: ProjectVisibility.RESTRICTED,
    });
    const issue = await createIssue(setup, { title: "Secret title", projectId: project.id });
    const membership = await getPrisma().membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: setup.secondUser.id,
          workspaceId: setup.workspace.id,
        },
      },
    });

    expect((await memberIssues.list({ includeDone: true, limit: 50 })).items).toHaveLength(0);
    expect((await memberIssues.count({ includeDone: true, limit: 50 })).count).toBe(0);
    await expect(memberIssues.byId({ id: issue.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await ownerAccess.set({
      projectId: project.id,
      membershipId: membership.id,
      role: ProjectAccessRole.VIEWER,
    });
    await expect(memberIssues.byId({ id: issue.id })).resolves.toMatchObject({ id: issue.id });
    await expect(memberIssues.update({ id: issue.id, title: "No" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await ownerAccess.set({
      projectId: project.id,
      membershipId: membership.id,
      role: ProjectAccessRole.CONTRIBUTOR,
    });
    await expect(memberIssues.update({ id: issue.id, title: "Allowed" })).resolves.toMatchObject({
      title: "Allowed",
    });
  });

  it("removes restricted work from dashboard, inbox, global work, and search", async () => {
    const setup = await fixture("RPS");
    const ownerProjects = projectRouter.createCaller(await buildContext(setup));
    const ownerAccess = projectAccessRouter.createCaller(await buildContext(setup));
    const memberContext = await buildContext(setup, { asUserId: setup.secondUser.id });
    const dashboard = dashboardRouter.createCaller(memberContext);
    const inbox = inboxRouter.createCaller(memberContext);
    const global = globalRouter.createCaller(memberContext);
    const palette = commandPaletteRouter.createCaller(memberContext);
    const project = await ownerProjects.create({
      key: "HIDE",
      name: "Hidden project",
      visibility: ProjectVisibility.RESTRICTED,
    });
    const issue = await createIssue(setup, { title: "Needle secret", projectId: project.id });
    await getPrisma().issue.update({
      where: { id: issue.id },
      data: { dueDate: new Date(Date.now() + 86_400_000) },
    });
    await getPrisma().issueAssignee.create({
      data: { issueId: issue.id, userId: setup.secondUser.id },
    });
    const membership = await getPrisma().membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: setup.secondUser.id,
          workspaceId: setup.workspace.id,
        },
      },
    });

    expect((await dashboard.today()).dueSoon).toHaveLength(0);
    expect((await inbox.get({ allWorkspaces: false })).assignedUnblocked).toHaveLength(0);
    expect(await global.work()).toHaveLength(0);
    expect((await global.summary()).openIssues).toBe(0);
    expect((await palette.search({ query: "Needle secret" })).issues).toHaveLength(0);

    await ownerAccess.set({
      projectId: project.id,
      membershipId: membership.id,
      role: ProjectAccessRole.VIEWER,
    });
    expect((await dashboard.today()).dueSoon.map((row) => row.id)).toEqual([issue.id]);
    expect(
      (await inbox.get({ allWorkspaces: false })).assignedUnblocked.map((row) => row.id),
    ).toEqual([issue.id]);
    expect((await global.work()).map((row) => row.id)).toEqual([issue.id]);
    expect((await palette.search({ query: "Needle secret" })).issues.map((row) => row.id)).toEqual([
      issue.id,
    ]);
  });
});
