import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RelationKind } from "@prisma/client";
import { commentRouter } from "@/server/routers/comment";
import { labelRouter } from "@/server/routers/label";
import { relationRouter } from "@/server/routers/relation";
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

async function setup(keyPrefix: string) {
  const fixture = await createWorkspaceFixture({ keyPrefix });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  return {
    fixture,
    comment: commentRouter.createCaller(ctx),
    label: labelRouter.createCaller(ctx),
    relation: relationRouter.createCaller(ctx),
  };
}

describe("archived issue mutation surfaces", () => {
  it("keeps labels, comments, and relationships read-only until restore", async () => {
    const { fixture, comment, label, relation } = await setup("IAS");
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Archive boundary" });
    const peer = await createIssue(fixture, { title: "Related active issue" });
    const workspaceLabel = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "Archive test", color: "#8a6f5a" },
    });
    const createdComment = await comment.create({ issueId: issue.id, body: "Preserve me" });
    const createdRelation = await relation.add({
      fromIssueId: issue.id,
      toIssueId: peer.id,
      kind: RelationKind.RELATES_TO,
    });

    await prisma.issue.update({ where: { id: issue.id }, data: { deletedAt: new Date() } });

    await expect(
      label.setForIssue({ issueId: issue.id, labelIds: [workspaceLabel.id] }),
    ).rejects.toThrow();
    await expect(comment.create({ issueId: issue.id, body: "Too late" })).rejects.toThrow(
      /not found/i,
    );
    await expect(comment.update({ id: createdComment.id, body: "Too late" })).rejects.toThrow(
      /not found/i,
    );
    await expect(comment.softDelete({ id: createdComment.id })).rejects.toThrow(/not found/i);
    await expect(relation.remove({ relationId: createdRelation.relation.id })).rejects.toThrow(
      /restore archived/i,
    );

    expect(
      await prisma.issueLabel.count({ where: { issueId: issue.id, labelId: workspaceLabel.id } }),
    ).toBe(0);
    expect(
      (await prisma.comment.findUniqueOrThrow({ where: { id: createdComment.id } })).deletedAt,
    ).toBeNull();
    expect(await prisma.issueRelation.count({ where: { id: createdRelation.relation.id } })).toBe(
      1,
    );
  });

  it("scopes comment deletion and label assignment to the caller workspace", async () => {
    const owner = await setup("IAO");
    const outsider = await setup("IAX");
    const prisma = getPrisma();
    const issue = await createIssue(owner.fixture, { title: "Tenant boundary" });
    const createdComment = await owner.comment.create({ issueId: issue.id, body: "Owner note" });
    const foreignLabel = await prisma.label.create({
      data: {
        workspaceId: outsider.fixture.workspace.id,
        name: "Foreign",
        color: "#8a6f5a",
      },
    });

    await expect(outsider.comment.softDelete({ id: createdComment.id })).rejects.toThrow(
      /not found/i,
    );
    await expect(
      owner.label.setForIssue({ issueId: issue.id, labelIds: [foreignLabel.id] }),
    ).rejects.toThrow(/workspace/i);

    expect(
      (await prisma.comment.findUniqueOrThrow({ where: { id: createdComment.id } })).deletedAt,
    ).toBeNull();
  });
});
