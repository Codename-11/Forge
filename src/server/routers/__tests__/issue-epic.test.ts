import { describe, it, expect, afterAll, afterEach } from "vitest";
import { WorkItemKind } from "@prisma/client";
import { issueRouter } from "@/server/routers/issue";
import {
  createWorkspaceFixture,
  buildContext,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Coverage for Epics (WorkItemKind.EPIC) + the sub-issue tree they scope:
 * kind on create/update, the `issue.children` rollup, and the `kinds`
 * list filter that powers the Epics view.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "EPC" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = issueRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("issueRouter — epics + sub-issues", () => {
  it("creates an Epic and updates kind back to Issue", async () => {
    const { caller } = await setup();
    const epic = await caller.create({ title: "Epic A", kind: WorkItemKind.EPIC });
    expect(epic.kind).toBe(WorkItemKind.EPIC);

    const updated = await caller.update({ id: epic.id, kind: WorkItemKind.ISSUE });
    expect(updated.kind).toBe(WorkItemKind.ISSUE);
  });

  it("children rollup counts done (terminal) vs total", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const epic = await caller.create({ title: "Epic", kind: WorkItemKind.EPIC });

    // Three children under the epic.
    const c1 = await caller.create({ title: "Child 1", parentId: epic.id });
    const c2 = await caller.create({ title: "Child 2", parentId: epic.id });
    await caller.create({ title: "Child 3", parentId: epic.id });

    // Move two of them to terminal statuses (DONE + CANCELED).
    const doneStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    const canceledStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "CANCELED" },
    });
    await caller.update({ id: c1.id, statusId: doneStatus.id });
    await caller.update({ id: c2.id, statusId: canceledStatus.id });

    const res = await caller.children({ parentId: epic.id });
    expect(res.total).toBe(3);
    expect(res.done).toBe(2);
    // Ordered + carries status + kind for the panel.
    expect(res.items.every((i) => typeof i.status.category === "string")).toBe(true);
  });

  it("kinds filter narrows issue.list to epics", async () => {
    const { fixture, caller } = await setup();
    await caller.create({ title: "Epic", kind: WorkItemKind.EPIC });
    await createIssue(fixture, { title: "Plain issue" });

    const onlyEpics = await caller.list({ kinds: [WorkItemKind.EPIC], includeDone: true, limit: 50 });
    expect(onlyEpics.items.length).toBe(1);
    expect(onlyEpics.items[0].kind).toBe(WorkItemKind.EPIC);

    const all = await caller.list({ includeDone: true, limit: 50 });
    expect(all.items.length).toBe(2);
  });

  it("children query rejects a parent from another workspace", async () => {
    const { caller } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "EP2" });
    fixtures.push(other);
    const foreign = await createIssue(other, { title: "foreign epic" });
    await expect(caller.children({ parentId: foreign.id })).rejects.toThrow();
  });
});
