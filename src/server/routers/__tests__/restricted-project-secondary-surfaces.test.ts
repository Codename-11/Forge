import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ProjectAccessRole, ProjectVisibility, RelationKind } from "@prisma/client";
import { commentRouter } from "@/server/routers/comment";
import { labelRouter } from "@/server/routers/label";
import { relationRouter } from "@/server/routers/relation";
import { timeEntryRouter } from "@/server/routers/timeEntry";
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

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "RPS" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const member = await prisma.membership.findUniqueOrThrow({
    where: {
      userId_workspaceId: {
        userId: fixture.secondUser.id,
        workspaceId: fixture.workspace.id,
      },
    },
  });
  const restrictedProject = await prisma.project.create({
    data: {
      workspaceId: fixture.workspace.id,
      key: "RSTR",
      name: "Restricted",
      visibility: ProjectVisibility.RESTRICTED,
      createdById: fixture.user.id,
    },
  });
  const publicProject = await prisma.project.create({
    data: {
      workspaceId: fixture.workspace.id,
      key: "PUB",
      name: "Workspace visible",
      createdById: fixture.user.id,
    },
  });
  const restrictedIssue = await createIssue(fixture, {
    title: "Restricted issue",
    projectId: restrictedProject.id,
  });
  const publicIssue = await createIssue(fixture, {
    title: "Public issue",
    projectId: publicProject.id,
  });
  const memberCtx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
  return {
    fixture,
    member,
    memberCtx,
    restrictedProject,
    restrictedIssue,
    publicIssue,
  };
}

describe("restricted project secondary surfaces", () => {
  it("hides comment reads and rejects comment and label writes without contribute access", async () => {
    const { fixture, memberCtx, restrictedIssue } = await setup();
    const prisma = getPrisma();
    const comment = await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: restrictedIssue.id,
        authorId: fixture.user.id,
        body: "private details",
      },
    });
    const label = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "restricted-test", color: "#123456" },
    });
    const comments = commentRouter.createCaller(memberCtx);
    const labels = labelRouter.createCaller(memberCtx);

    await expect(comments.listForIssue({ issueId: restrictedIssue.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(comments.history({ commentId: comment.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      comments.create({ issueId: restrictedIssue.id, body: "unauthorized" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      labels.setForIssue({ issueId: restrictedIssue.id, labelIds: [label.id] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires access to both relation endpoints and omits inaccessible targets from reads", async () => {
    const {
      fixture,
      member,
      memberCtx,
      restrictedProject,
      restrictedIssue,
      publicIssue,
    } = await setup();
    const prisma = getPrisma();
    const relation = await prisma.issueRelation.create({
      data: {
        workspaceId: fixture.workspace.id,
        fromIssueId: publicIssue.id,
        toIssueId: restrictedIssue.id,
        kind: RelationKind.RELATES_TO,
      },
    });
    const caller = relationRouter.createCaller(memberCtx);

    const visible = await caller.listForIssue({ issueId: publicIssue.id });
    expect(visible.RELATES_TO).toEqual([]);
    await expect(
      caller.add({
        fromIssueId: publicIssue.id,
        toIssueId: restrictedIssue.id,
        kind: RelationKind.DUPLICATES,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.remove({ relationId: relation.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: restrictedProject.id,
        membershipId: member.id,
        role: ProjectAccessRole.CONTRIBUTOR,
        grantedById: fixture.user.id,
      },
    });
    await expect(
      caller.add({
        fromIssueId: publicIssue.id,
        toIssueId: restrictedIssue.id,
        kind: RelationKind.DUPLICATES,
      }),
    ).resolves.toMatchObject({ relation: { kind: RelationKind.DUPLICATES } });
  });

  it("filters time reads and summaries and rejects writes for inaccessible issues", async () => {
    const { fixture, memberCtx, restrictedIssue, publicIssue } = await setup();
    const prisma = getPrisma();
    const now = new Date();
    await prisma.timeEntry.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.secondUser.id,
          issueId: publicIssue.id,
          startedAt: new Date(now.getTime() - 60 * 60 * 1000),
          endedAt: now,
        },
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.secondUser.id,
          issueId: restrictedIssue.id,
          startedAt: new Date(now.getTime() - 30 * 60 * 1000),
          endedAt: now,
        },
      ],
    });
    const caller = timeEntryRouter.createCaller(memberCtx);

    const rows = await caller.list();
    expect(rows.map((row) => row.issueId)).toEqual([publicIssue.id]);
    const summary = await caller.summary({
      from: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      to: new Date(now.getTime() + 60_000),
      groupBy: "issue",
    });
    expect(summary.totalMinutes).toBe(60);
    expect(summary.buckets.map((bucket) => bucket.key)).toEqual([publicIssue.id]);
    await expect(caller.start({ issueId: restrictedIssue.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
