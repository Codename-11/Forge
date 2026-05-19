import { afterAll, afterEach, describe, expect, it } from "vitest";
import { contextSetRouter } from "@/server/routers/context-set";
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
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await f.cleanup();
  }
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "CSE" });
  fixtures.push(fixture);
  const prisma = getPrisma();
  const ctx = await buildContext(fixture);
  const caller = contextSetRouter.createCaller(ctx);
  return { fixture, prisma, caller };
}

describe("contextSetRouter", () => {
  it("creates a context set with seeded items and hydrates them", async () => {
    const { fixture, prisma, caller } = await setup();
    const issue = await createIssue(fixture);
    const note = await prisma.note.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        body: "design notes",
      },
    });
    const created = await caller.create({
      name: "Auth migration context",
      description: "Everything the migration agent needs to act.",
      items: [
        { targetType: "issue", targetId: issue.id, includeMode: "INCLUDE" },
        { targetType: "note", targetId: note.id, includeMode: "SUMMARY_ONLY", note: "design notes" },
      ],
    });
    const got = await caller.get({ id: created.id });
    expect(got.name).toBe("Auth migration context");
    expect(got.items).toHaveLength(2);
    expect(got.items[0].type).toBe("issue");
    expect(got.items[0].missing).toBe(false);
    expect(got.items[0].includeMode).toBe("INCLUDE");
    expect(got.items[1].type).toBe("note");
    expect(got.items[1].includeMode).toBe("SUMMARY_ONLY");
  });

  it("adds and removes items idempotently", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const set = await caller.create({ name: "Set" });
    const a = await caller.addItem({
      contextSetId: set.id,
      targetType: "issue",
      targetId: issue.id,
    });
    const b = await caller.addItem({
      contextSetId: set.id,
      targetType: "issue",
      targetId: issue.id,
      includeMode: "EXCLUDE",
    });
    expect(b.id).toBe(a.id);
    const got = await caller.get({ id: set.id });
    expect(got.items).toHaveLength(1);
    expect(got.items[0].includeMode).toBe("EXCLUDE");

    await caller.removeItem({ contextSetId: set.id, itemId: a.id });
    const afterRemove = await caller.get({ id: set.id });
    expect(afterRemove.items).toHaveLength(0);
  });

  it("archives a context set and hides it from list() by default", async () => {
    const { caller } = await setup();
    const live = await caller.create({ name: "Live" });
    const dead = await caller.create({ name: "Dead" });
    await caller.archive({ id: dead.id });
    const list = await caller.list({ limit: 50 });
    expect(list.items.find((row) => row.id === live.id)).toBeTruthy();
    expect(list.items.find((row) => row.id === dead.id)).toBeUndefined();
    const all = await caller.list({ limit: 50, includeArchived: true });
    expect(all.items.find((row) => row.id === dead.id)).toBeTruthy();
  });

  it("hydrates a missing target with the dead-ref fallback", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const set = await caller.create({ name: "Set" });
    await caller.addItem({
      contextSetId: set.id,
      targetType: "issue",
      targetId: issue.id,
    });
    // Hard delete the issue out from under the ref
    await getPrisma().issue.delete({ where: { id: issue.id } });
    const got = await caller.get({ id: set.id });
    expect(got.items).toHaveLength(1);
    expect(got.items[0].missing).toBe(true);
  });

  it("patches includeMode and note on a single item", async () => {
    const { fixture, caller } = await setup();
    const issue = await createIssue(fixture);
    const set = await caller.create({ name: "Set" });
    const item = await caller.addItem({
      contextSetId: set.id,
      targetType: "issue",
      targetId: issue.id,
    });
    await caller.patchItem({
      contextSetId: set.id,
      itemId: item.id,
      includeMode: "SUMMARY_ONLY",
      note: "summarize only",
    });
    const got = await caller.get({ id: set.id });
    expect(got.items[0].includeMode).toBe("SUMMARY_ONLY");
    expect(got.items[0].note).toBe("summarize only");
  });
});
