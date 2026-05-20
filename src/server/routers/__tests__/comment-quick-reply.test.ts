import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ActionRequestKind } from "@prisma/client";
import { commentRouter } from "@/server/routers/comment";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Coverage for the comment.create extensions:
 *   - suggestedReplies persists onto the row (and respects the cap)
 *   - actionRequest bundle creates a paired row bound via sourceType/sourceId
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "CQR" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  return { fixture, ctx, caller: commentRouter.createCaller(ctx) };
}

describe("commentRouter.create — quick-reply chips", () => {
  it("persists suggestedReplies onto the row", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);

    const created = await caller.create({
      issueId: issue.id,
      body: "Should I mark this done?",
      suggestedReplies: ["Yes, ship it", "Wait — verify the build first"],
    });

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.suggestedReplies).toEqual([
      "Yes, ship it",
      "Wait — verify the build first",
    ]);
  });

  it("rejects more than 4 quick replies", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    await expect(
      caller.create({
        issueId: issue.id,
        body: "Too many?",
        suggestedReplies: ["a", "b", "c", "d", "e"],
      }),
    ).rejects.toThrow();
  });

  it("rejects a reply longer than 80 chars", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    await expect(
      caller.create({
        issueId: issue.id,
        body: "Too long?",
        suggestedReplies: ["x".repeat(81)],
      }),
    ).rejects.toThrow();
  });

  it("missing suggestedReplies persists as an empty array", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const created = await caller.create({
      issueId: issue.id,
      body: "Plain comment.",
    });
    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.suggestedReplies).toEqual([]);
  });
});

describe("commentRouter.create — inline actionRequest bundle", () => {
  it("creates a paired ActionRequest bound to the new comment", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });

    const created = await caller.create({
      issueId: issue.id,
      body: "Verified locally — ready to ship.",
      actionRequest: {
        title: "Mark this as Done",
        kind: ActionRequestKind.TRANSITION,
        payload: { statusId: done.id },
      },
    });

    const ar = await prisma.actionRequest.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        sourceType: "comment",
        sourceId: created.id,
      },
    });
    expect(ar.kind).toBe(ActionRequestKind.TRANSITION);
    expect(ar.issueId).toBe(issue.id);
    expect((ar.payload as { statusId?: string }).statusId).toBe(done.id);
  });

  it("forComment query returns the bound row", async () => {
    const { fixture, ctx, caller } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const done = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });

    const created = await caller.create({
      issueId: issue.id,
      body: "Suggestion.",
      actionRequest: {
        title: "Mark Done",
        kind: ActionRequestKind.TRANSITION,
        payload: { statusId: done.id },
      },
    });

    const { actionRequestRouter } = await import("@/server/routers/action-request");
    const arCaller = actionRequestRouter.createCaller(ctx);
    const fetched = await arCaller.forComment({ commentId: created.id });
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe("Mark Done");
    expect(fetched?.kind).toBe(ActionRequestKind.TRANSITION);
  });
});
