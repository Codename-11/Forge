import { describe, it, expect, afterAll, afterEach } from "vitest";
import { NoteStatus } from "@prisma/client";
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
 *   - list filters: status (single/array), pinned, search.
 *   - setStatus emits an audit + activity event.
 *   - promote(issue|project|initiative) creates the downstream entity,
 *     stamps sourceNoteId, and flips note.status to ACTIVE.
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
    expect(issue.sourceNoteId).toBe(note.id);

    // Note still exists, not auto-archived.
    const reread = await caller.list({});
    expect(reread.items.find((n) => n.id === note.id)?.archivedAt).toBeNull();
  });

  it("list filters by status (single + array) and pinned", async () => {
    const { ctx } = await setup();
    const caller = noteRouter.createCaller(ctx);

    const idea = await caller.create({ body: "Pitch — try X" });
    expect(idea.status).toBe("IDEA");
    const someday = await caller.create({ body: "Read paper Y" });
    await caller.setStatus({ noteId: someday.id, status: NoteStatus.SOMEDAY });
    const active = await caller.create({ body: "Active work item Z", pinned: true });
    await caller.setStatus({ noteId: active.id, status: NoteStatus.ACTIVE });

    const all = await caller.list({});
    expect(all.items).toHaveLength(3);

    const ideas = await caller.list({ status: NoteStatus.IDEA });
    expect(ideas.items.map((n) => n.id)).toEqual([idea.id]);

    const ideasOrSomeday = await caller.list({
      status: [NoteStatus.IDEA, NoteStatus.SOMEDAY],
    });
    expect(new Set(ideasOrSomeday.items.map((n) => n.id))).toEqual(
      new Set([idea.id, someday.id]),
    );

    const pinnedOnly = await caller.list({ pinned: true });
    expect(pinnedOnly.items.map((n) => n.id)).toEqual([active.id]);

    const searched = await caller.list({ search: "paper" });
    expect(searched.items.map((n) => n.id)).toEqual([someday.id]);
  });

  it("setStatus updates the note and emits an audit + activity event", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const caller = noteRouter.createCaller(ctx);

    const note = await caller.create({ body: "Park this for later" });
    expect(note.status).toBe("IDEA");

    const updated = await caller.setStatus({
      noteId: note.id,
      status: NoteStatus.SOMEDAY,
    });
    expect(updated.status).toBe("SOMEDAY");

    const audits = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Note",
        entityId: note.id,
        action: "status.set",
      },
    });
    expect(audits).toHaveLength(1);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "note",
        subjectId: note.id,
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // No-op when status is already the target — should not flip
    // updatedAt or emit another audit.
    const auditCountBefore = (
      await prisma.auditLog.findMany({
        where: { workspaceId: fixture.workspace.id, entityId: note.id },
      })
    ).length;
    const same = await caller.setStatus({
      noteId: note.id,
      status: NoteStatus.SOMEDAY,
    });
    expect(same.status).toBe("SOMEDAY");
    const auditCountAfter = (
      await prisma.auditLog.findMany({
        where: { workspaceId: fixture.workspace.id, entityId: note.id },
      })
    ).length;
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  it("promote(issue) creates an Issue with sourceNoteId + flips status to ACTIVE", async () => {
    const { ctx } = await setup();
    const prisma = getPrisma();
    const caller = noteRouter.createCaller(ctx);

    const note = await caller.create({
      title: "Smooth out the dispatcher fallback",
      body: "When CAPABILITY_MATCH yields zero, round-robin should kick in.",
    });

    const result = await caller.promote({ noteId: note.id, kind: "issue" });
    expect(result.target.kind).toBe("issue");
    expect(result.note.status).toBe("ACTIVE");
    expect(result.note.promotedToType).toBe("issue");
    expect(result.note.promotedToId).toBe(result.target.id);

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: result.target.id },
    });
    expect(issue.title).toBe("Smooth out the dispatcher fallback");
    expect(issue.description).toContain("CAPABILITY_MATCH");
    expect(issue.sourceNoteId).toBe(note.id);
  });

  it("promote(project) creates a Project linked back to the note", async () => {
    const { ctx } = await setup();
    const prisma = getPrisma();
    const caller = noteRouter.createCaller(ctx);

    const note = await caller.create({
      title: "Forge Mobile",
      body: "Companion iOS app for inbox + assignment.",
    });

    const result = await caller.promote({ noteId: note.id, kind: "project" });
    expect(result.target.kind).toBe("project");
    expect(result.note.status).toBe("ACTIVE");
    expect(result.note.promotedToType).toBe("project");

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: result.target.id },
    });
    expect(project.name).toBe("Forge Mobile");
    expect(project.description).toContain("Companion iOS");
    expect(project.sourceNoteId).toBe(note.id);
    expect(project.key).toMatch(/^[A-Z0-9]{2,8}$/);
  });

  it("promote(initiative) creates an Initiative linked back to the note", async () => {
    const { ctx } = await setup();
    const prisma = getPrisma();
    const caller = noteRouter.createCaller(ctx);

    const note = await caller.create({
      title: "Agent autonomy push",
      body: "All Q3 work goes under this theme.",
    });

    const result = await caller.promote({
      noteId: note.id,
      kind: "initiative",
    });
    expect(result.target.kind).toBe("initiative");
    expect(result.note.status).toBe("ACTIVE");
    expect(result.note.promotedToType).toBe("initiative");

    const initiative = await prisma.initiative.findUniqueOrThrow({
      where: { id: result.target.id },
    });
    expect(initiative.name).toBe("Agent autonomy push");
    expect(initiative.description).toContain("Q3");
    expect(initiative.sourceNoteId).toBe(note.id);
    expect(initiative.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("create accepts an explicit status override", async () => {
    const { ctx } = await setup();
    const caller = noteRouter.createCaller(ctx);
    const note = await caller.create({
      body: "Already in progress — not a fresh idea",
      status: NoteStatus.ACTIVE,
    });
    expect(note.status).toBe("ACTIVE");
  });
});
