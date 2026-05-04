import { describe, it, expect, afterAll, afterEach } from "vitest";
import { noteRouter } from "@/server/routers/note";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for the note router. Confirms:
 *   - create + list + update + archive lifecycle.
 *   - per-user isolation: another user can't see / mutate the row.
 *   - convertToIssue spawns an Issue without auto-archiving the note.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "NOTE" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  return { fixture, ctx };
}

describe("noteRouter", () => {
  it("create → list → update → archive lifecycle", async () => {
    const { ctx } = await setup();
    const caller = noteRouter.createCaller(ctx);

    const created = await caller.create({
      body: "Look at the staging env logs again",
      title: "TODO: staging logs",
    });
    expect(created.id).toBeTruthy();
    expect(created.title).toBe("TODO: staging logs");
    expect(created.archivedAt).toBeNull();

    const listed = await caller.list({});
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].id).toBe(created.id);

    const updated = await caller.update({ id: created.id, pinned: true });
    expect(updated.pinned).toBe(true);

    await caller.archive({ id: created.id });
    const afterArchive = await caller.list({});
    expect(afterArchive.items).toHaveLength(0);

    const archivedList = await caller.list({ archived: true });
    expect(archivedList.items).toHaveLength(1);
  });

  it("hides notes owned by other users", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const caller = noteRouter.createCaller(ctx);
    await caller.create({ body: "Mine — should be visible to me" });

    // Spawn a fresh user and write a note for them in the same workspace.
    const otherUser = await prisma.user.create({
      data: {
        email: `note-other-${Date.now()}@example.com`,
        name: "Other",
      },
    });
    await prisma.membership.create({
      data: {
        userId: otherUser.id,
        workspaceId: fixture.workspace.id,
        role: "MEMBER",
      },
    });
    await prisma.note.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: otherUser.id,
        body: "Theirs — should NOT be visible to me",
      },
    });

    const { items } = await caller.list({});
    expect(items).toHaveLength(1);
    expect(items[0].body).toContain("Mine");
  });

  it("convertToIssue spawns an Issue and leaves the note in place", async () => {
    const { ctx } = await setup();
    const prisma = getPrisma();
    const caller = noteRouter.createCaller(ctx);

    const note = await caller.create({
      title: "Investigate dispatch latency",
      body: "Spike on Tuesday morning, 30s+ tail latency.",
    });

    const result = await caller.convertToIssue({ id: note.id });
    expect(result.issueId).toBeTruthy();
    expect(result.number).toBe(1);
    expect(result.issueKey.endsWith("-1")).toBe(true);

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: result.issueId },
    });
    expect(issue.title).toBe("Investigate dispatch latency");
    expect(issue.description).toContain("Spike on Tuesday");

    // Note still exists, not auto-archived.
    const reread = await caller.list({});
    expect(reread.items.find((n) => n.id === note.id)?.archivedAt).toBeNull();
  });
});
