import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfidenceLevel } from "@prisma/client";
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
 * Comment edit history + confidence flag (migration 0050).
 *
 * - `update` writes the OLD body + previous updatedAt onto the
 *   `revisions` array and bumps `editedAt`. Capped at 20 entries —
 *   oldest dropped first.
 * - `create` accepts an optional `confidence` enum value persisted
 *   on the row.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "HIS" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  return {
    fixture,
    ctx,
    prisma: getPrisma(),
    caller: commentRouter.createCaller(ctx),
  };
}

describe("commentRouter.update — revision history", () => {
  it("first edit captures the original body and bumps editedAt", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({
      issueId: issue.id,
      body: "first draft",
    });

    await caller.update({ id: created.id, body: "second draft" });
    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    const revisions = row.revisions as Array<{ body: string; editedAt: string }>;
    expect(Array.isArray(revisions)).toBe(true);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].body).toBe("first draft");
    expect(row.body).toBe("second draft");
    expect(row.editedAt).toBeInstanceOf(Date);
  });

  it("subsequent edits append to revisions (oldest first)", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({ issueId: issue.id, body: "v1" });

    await caller.update({ id: created.id, body: "v2" });
    await caller.update({ id: created.id, body: "v3" });
    await caller.update({ id: created.id, body: "v4" });

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    const revisions = row.revisions as Array<{ body: string }>;
    expect(revisions.map((r) => r.body)).toEqual(["v1", "v2", "v3"]);
    expect(row.body).toBe("v4");
  });

  it("caps revisions at BODY_REVISION_CAP entries", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({ issueId: issue.id, body: "v0" });

    // Drive the array past the cap (20). After 25 edits, the array
    // holds the last 20 historical bodies (v0…v19 replaced by
    // v5…v24); current body is v25.
    for (let i = 1; i <= 25; i += 1) {
      await caller.update({ id: created.id, body: `v${i}` });
    }
    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    const revisions = row.revisions as Array<{ body: string }>;
    expect(revisions).toHaveLength(20);
    // Oldest survivor should be v5; newest historical should be v24.
    expect(revisions[0].body).toBe("v5");
    expect(revisions[19].body).toBe("v24");
    expect(row.body).toBe("v25");
  });

  it("comment.history returns the revisions array + current body", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({ issueId: issue.id, body: "alpha" });
    await caller.update({ id: created.id, body: "beta" });

    const history = await caller.history({ commentId: created.id });
    expect(history.currentBody).toBe("beta");
    const revisions = history.revisions as Array<{ body: string }>;
    expect(revisions).toHaveLength(1);
    expect(revisions[0].body).toBe("alpha");
    expect(history.editedAt).not.toBeNull();
  });

  it("no-op update (identical body) does not push a revision", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({ issueId: issue.id, body: "same" });
    await caller.update({ id: created.id, body: "same" });
    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    const revisions = row.revisions as unknown[];
    expect(revisions).toEqual([]);
    expect(row.editedAt).toBeNull();
  });
});

describe("commentRouter.create — confidence flag", () => {
  it("persists the confidence column when provided", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({
      issueId: issue.id,
      body: "I think this is wrong",
      confidence: ConfidenceLevel.LOW,
    });
    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.confidence).toBe(ConfidenceLevel.LOW);
  });

  it("defaults to null when unspecified", async () => {
    const { fixture, caller, prisma } = await setup();
    const issue = await createIssue(fixture);
    const created = await caller.create({
      issueId: issue.id,
      body: "unflagged",
    });
    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.confidence).toBeNull();
  });
});
