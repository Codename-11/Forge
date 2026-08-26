import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ArtifactVisibility, ProjectAccessRole, ProjectVisibility } from "@prisma/client";
import { artifactRouter } from "@/server/routers/artifact";
import { attachmentRouter } from "@/server/routers/attachment";
import { canvasRouter } from "@/server/routers/canvas";
import { contextSetRouter } from "@/server/routers/context-set";
import { hydrateEntityRefs } from "@/server/services/entity-hydration";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "RRA" });
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
      key: "SECRET",
      name: "Restricted project",
      visibility: ProjectVisibility.RESTRICTED,
      createdById: fixture.user.id,
    },
  });
  const issue = await createIssue(fixture, { projectId: project.id, title: "Hidden issue" });
  const artifact = await prisma.artifact.create({
    data: {
      workspaceId: fixture.workspace.id,
      title: "Hidden artifact",
      slug: `hidden-${project.id}`,
      body: "private",
      visibility: ArtifactVisibility.WORKSPACE,
      createdById: fixture.user.id,
      issueId: issue.id,
      projectId: project.id,
    },
  });
  const attachment = await prisma.attachment.create({
    data: {
      workspaceId: fixture.workspace.id,
      issueId: issue.id,
      targetType: "issue",
      targetId: issue.id,
      filename: "secret.txt",
      mimeType: "text/plain",
      size: 1,
      url: `attachments/${fixture.workspace.id}/secret.txt`,
    },
  });
  const plan = await prisma.executionPlan.create({
    data: {
      workspaceId: fixture.workspace.id,
      title: "Hidden plan",
      issueId: issue.id,
      projectId: project.id,
    },
  });
  const step = await prisma.executionStep.create({
    data: {
      workspaceId: fixture.workspace.id,
      planId: plan.id,
      title: "Hidden step",
      position: 0,
      issueId: issue.id,
    },
  });
  const canvas = await prisma.workspaceCanvas.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Resource board",
      createdById: fixture.user.id,
      nodes: {
        create: [
          {
            workspaceId: fixture.workspace.id,
            targetType: "artifact",
            targetId: artifact.id,
            x: 0,
            y: 0,
            width: 320,
            height: 200,
          },
          {
            workspaceId: fixture.workspace.id,
            targetType: "execution-plan",
            targetId: plan.id,
            x: 340,
            y: 0,
            width: 320,
            height: 200,
          },
        ],
      },
    },
  });
  const contextSet = await prisma.contextSet.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: "Mixed context",
      ownerUserId: fixture.secondUser.id,
      items: {
        create: [
          {
            workspaceId: fixture.workspace.id,
            targetType: "issue",
            targetId: issue.id,
          },
          {
            workspaceId: fixture.workspace.id,
            targetType: "execution-step",
            targetId: step.id,
            position: 1,
          },
        ],
      },
    },
  });
  const ctx = await buildContext(fixture, { asUserId: fixture.secondUser.id });
  return { fixture, membership, project, issue, artifact, attachment, plan, step, canvas, contextSet, ctx };
}

describe("restricted project resource authorization", () => {
  it("does not let artifact visibility or an attachment URL widen project access", async () => {
    const { artifact, attachment, issue, ctx } = await setup();
    const artifacts = artifactRouter.createCaller(ctx);
    const attachments = attachmentRouter.createCaller(ctx);

    await expect(artifacts.get({ id: artifact.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      attachments.list({ targetType: "issue", targetId: issue.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      attachments.getDownloadUrl({ attachmentId: attachment.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("marks inaccessible canvas and context descendants missing, then reflects grant revocation", async () => {
    const { fixture, membership, project, issue, artifact, plan, step, canvas, contextSet, ctx } =
      await setup();
    const prisma = getPrisma();
    const canvases = canvasRouter.createCaller(ctx);
    const contexts = contextSetRouter.createCaller(ctx);

    const hiddenCanvas = await canvases.hydrate({ id: canvas.id });
    expect(hiddenCanvas.nodes.map((node) => node.ref.missing)).toEqual([true, true]);
    const hiddenContext = await contexts.get({ id: contextSet.id });
    expect(hiddenContext.items.map((item) => item.missing)).toEqual([true, true]);

    const grant = await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: project.id,
        membershipId: membership.id,
        role: ProjectAccessRole.VIEWER,
        grantedById: fixture.user.id,
      },
    });
    const visible = await hydrateEntityRefs(
      {
        db: prisma,
        workspaceId: fixture.workspace.id,
        userId: fixture.secondUser.id,
        membershipId: membership.id,
        membershipRole: membership.role,
      },
      [
        { type: "issue", id: issue.id },
        { type: "artifact", id: artifact.id },
        { type: "execution-plan", id: plan.id },
        { type: "execution-step", id: step.id },
      ],
    );
    expect(visible.every((item) => !item.missing)).toBe(true);

    await prisma.projectAccess.delete({ where: { id: grant.id } });
    const revoked = await hydrateEntityRefs(
      {
        db: prisma,
        workspaceId: fixture.workspace.id,
        userId: fixture.secondUser.id,
        membershipId: membership.id,
        membershipRole: membership.role,
      },
      [{ type: "artifact", id: artifact.id }, { type: "execution-plan", id: plan.id }],
    );
    expect(revoked.map((item) => item.missing)).toEqual([true, true]);
  });
});
