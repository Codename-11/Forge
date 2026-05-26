import { describe, it, expect, afterAll, afterEach } from "vitest";
import { RelationKind } from "@prisma/client";
import { relationRouter } from "@/server/routers/relation";
import {
  createWorkspaceFixture,
  buildContext,
  createIssue,
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "REL" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = relationRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("relationRouter", () => {
  it("BLOCKS creates the reciprocal BLOCKED_BY", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const res = await caller.add({
      fromIssueId: a.id,
      toIssueId: b.id,
      kind: RelationKind.BLOCKS,
    });
    expect(res.relation.kind).toBe(RelationKind.BLOCKS);
    expect(res.reciprocal?.kind).toBe(RelationKind.BLOCKED_BY);

    const stored = await prisma.issueRelation.findMany({
      where: { workspaceId: fixture.workspace.id },
      orderBy: { kind: "asc" },
    });
    expect(stored).toHaveLength(2);
    const kinds = stored.map((r) => r.kind).sort();
    expect(kinds).toEqual([RelationKind.BLOCKED_BY, RelationKind.BLOCKS].sort());
  });

  it("remove() deletes both sides of a BLOCKS edge", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });

    const res = await caller.add({
      fromIssueId: a.id,
      toIssueId: b.id,
      kind: RelationKind.BLOCKS,
    });
    await caller.remove({ relationId: res.relation.id });
    const leftover = await prisma.issueRelation.findMany({
      where: { workspaceId: fixture.workspace.id },
    });
    expect(leftover).toHaveLength(0);
  });

  it("rejects self-links and cross-workspace links", async () => {
    const { caller, fixture } = await setup();
    const a = await createIssue(fixture, { title: "A" });
    await expect(
      caller.add({ fromIssueId: a.id, toIssueId: a.id, kind: RelationKind.BLOCKS }),
    ).rejects.toThrow();

    // Create an issue in a separate workspace.
    const other = await createWorkspaceFixture({ keyPrefix: "OTR" });
    fixtures.push(other);
    const otherIssue = await createIssue(other, { title: "foreign" });
    await expect(
      caller.add({
        fromIssueId: a.id,
        toIssueId: otherIssue.id,
        kind: RelationKind.BLOCKS,
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate relations with a friendly message", async () => {
    const { caller, fixture } = await setup();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });
    await caller.add({ fromIssueId: a.id, toIssueId: b.id, kind: RelationKind.RELATES_TO });
    await expect(
      caller.add({ fromIssueId: a.id, toIssueId: b.id, kind: RelationKind.RELATES_TO }),
    ).rejects.toThrow(/already/i);
  });

  it("DUPLICATES is unidirectional (no reciprocal row)", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });
    await caller.add({ fromIssueId: a.id, toIssueId: b.id, kind: RelationKind.DUPLICATES });
    const rows = await prisma.issueRelation.findMany({
      where: { workspaceId: fixture.workspace.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(RelationKind.DUPLICATES);
  });

  it("listForIssue() groups by kind and flips direction on incoming edges", async () => {
    const { caller, fixture } = await setup();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });
    await caller.add({ fromIssueId: a.id, toIssueId: b.id, kind: RelationKind.BLOCKS });

    const forA = await caller.listForIssue({ issueId: a.id });
    expect(forA.BLOCKS).toHaveLength(1);
    expect(forA.BLOCKS[0].target.id).toBe(b.id);
    expect(forA.BLOCKED_BY).toHaveLength(0);

    const forB = await caller.listForIssue({ issueId: b.id });
    expect(forB.BLOCKED_BY).toHaveLength(1);
    expect(forB.BLOCKED_BY[0].target.id).toBe(a.id);
  });

  it("graphForIssue() maps the blocks chain with the focus flagged", async () => {
    const { caller, fixture } = await setup();
    const a = await createIssue(fixture, { title: "A" });
    const b = await createIssue(fixture, { title: "B" });
    const c = await createIssue(fixture, { title: "C" });
    // a blocks b, b blocks c → directed chain a → b → c.
    await caller.add({ fromIssueId: a.id, toIssueId: b.id, kind: RelationKind.BLOCKS });
    await caller.add({ fromIssueId: b.id, toIssueId: c.id, kind: RelationKind.BLOCKS });

    const g = await caller.graphForIssue({ issueId: b.id, depth: 2 });
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([a.id, b.id, c.id].sort());
    expect(g.nodes.find((n) => n.id === b.id)?.isCurrent).toBe(true);
    expect(g.nodes.filter((n) => n.isCurrent)).toHaveLength(1);

    const blocks = g.edges.filter((e) => e.kind === "blocks");
    expect(blocks).toContainEqual(
      expect.objectContaining({ from: a.id, to: b.id, kind: "blocks" }),
    );
    expect(blocks).toContainEqual(
      expect.objectContaining({ from: b.id, to: c.id, kind: "blocks" }),
    );
  });

  it("graphForIssue() includes parent/child sub-issue edges", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const parent = await createIssue(fixture, { title: "Parent" });
    const focus = await createIssue(fixture, { title: "Focus" });
    const child = await createIssue(fixture, { title: "Child" });
    await prisma.issue.update({ where: { id: focus.id }, data: { parentId: parent.id } });
    await prisma.issue.update({ where: { id: child.id }, data: { parentId: focus.id } });

    const g = await caller.graphForIssue({ issueId: focus.id, depth: 2 });
    const childEdges = g.edges.filter((e) => e.kind === "child");
    expect(childEdges).toContainEqual(
      expect.objectContaining({ from: parent.id, to: focus.id, kind: "child" }),
    );
    expect(childEdges).toContainEqual(
      expect.objectContaining({ from: focus.id, to: child.id, kind: "child" }),
    );
  });
});
