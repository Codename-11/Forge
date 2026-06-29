import { describe, it, expect, afterAll, afterEach } from "vitest";
import { dashboardRouter } from "@/server/routers/dashboard";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for `dashboard.myWork` — the enriched "You" zone
 * query (Focus + Pick-up). Real Postgres, one fresh workspace per test so
 * the tenant-scoped slices don't cross-talk in parallel runs.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "DSH" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = dashboardRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

async function assignToMe(issueId: string, userId: string) {
  await getPrisma().issueAssignee.create({ data: { issueId, userId } });
}

async function setPriority(issueId: string, priority: string) {
  await getPrisma().issue.update({
    where: { id: issueId },
    // priority is a Prisma enum; the string literal is accepted at runtime.
    data: { priority: priority as never },
  });
}

describe("dashboard.myWork — focus", () => {
  it("returns only my assigned, non-done issues, priority-ordered", async () => {
    const { fixture, caller } = await setup();
    const low = await createIssue(fixture, { title: "low" });
    const urgent = await createIssue(fixture, { title: "urgent" });
    const high = await createIssue(fixture, { title: "high" });
    const doneMine = await createIssue(fixture, { title: "done", statusCategory: "DONE" });
    const notMine = await createIssue(fixture, { title: "authored not assigned" });

    for (const i of [low, urgent, high, doneMine]) {
      await assignToMe(i.id, fixture.user.id);
    }
    await setPriority(low.id, "LOW");
    await setPriority(urgent.id, "URGENT");
    await setPriority(high.id, "HIGH");

    const { focus } = await caller.myWork();
    const ids = focus.map((f) => f.id);

    expect(ids).toEqual([urgent.id, high.id, low.id]); // priority desc
    expect(ids).not.toContain(doneMine.id); // terminal excluded
    expect(ids).not.toContain(notMine.id); // not assigned to me
  });
});

describe("dashboard.myWork — resume", () => {
  it("returns my recent work, de-duped against focus, terminal excluded", async () => {
    const { fixture, caller } = await setup();
    const assigned = await createIssue(fixture, { title: "assigned + authored" });
    await assignToMe(assigned.id, fixture.user.id);
    const authoredOnly = await createIssue(fixture, { title: "authored only" });
    const doneAuthored = await createIssue(fixture, {
      title: "done authored",
      statusCategory: "DONE",
    });

    const { focus, resume } = await caller.myWork();
    const focusIds = focus.map((f) => f.id);
    const resumeIds = resume.map((r) => r.id);

    expect(focusIds).toContain(assigned.id); // assigned → focus
    expect(resumeIds).not.toContain(assigned.id); // de-duped out of resume
    expect(resumeIds).toContain(authoredOnly.id); // authored, unassigned → resume
    expect(resumeIds).not.toContain(doneAuthored.id); // terminal excluded
  });

  it("orders by latest issue activity, including comments", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const commented = await createIssue(fixture, { title: "stale header, fresh comment" });
    const headerUpdated = await createIssue(fixture, { title: "fresh header only" });

    const staleHeaderAt = new Date("2026-01-01T10:00:00.000Z");
    const freshHeaderAt = new Date("2026-01-02T10:00:00.000Z");
    const commentAt = new Date("2026-01-03T10:00:00.000Z");

    await prisma.issue.update({
      where: { id: commented.id },
      data: { updatedAt: staleHeaderAt },
    });
    await prisma.issue.update({
      where: { id: headerUpdated.id },
      data: { updatedAt: freshHeaderAt },
    });
    await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: commented.id,
        authorId: fixture.secondUser.id,
        body: "This should count as dashboard activity.",
        createdAt: commentAt,
        updatedAt: commentAt,
      },
    });

    const { resume } = await caller.myWork({ limit: 6 });
    const card = resume.find((r) => r.id === commented.id);

    expect(resume[0]?.id).toBe(commented.id);
    expect(card).toBeDefined();
    expect(card!.updatedAt.toISOString()).toBe(staleHeaderAt.toISOString());
    expect(card!.activityAt.toISOString()).toBe(commentAt.toISOString());
  });

  it("includes issues I touched only by commenting", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const touched = await createIssue(fixture, { title: "commented by me" });
    await prisma.issue.update({
      where: { id: touched.id },
      data: { authorId: fixture.secondUser.id },
    });
    await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: touched.id,
        authorId: fixture.user.id,
        body: "I touched this issue via the thread.",
      },
    });

    const { focus, resume } = await caller.myWork({ limit: 6 });
    const resumeIds = resume.map((r) => r.id);

    expect(focus.map((f) => f.id)).not.toContain(touched.id);
    expect(resumeIds).toContain(touched.id);
  });
});

describe("dashboard.myWork — card enrichment", () => {
  it("rolls up sub-issues (excluding canceled) and surfaces the latest run", async () => {
    const { fixture, caller } = await setup();
    const prisma = getPrisma();
    const parent = await createIssue(fixture, { title: "parent epic" });
    await assignToMe(parent.id, fixture.user.id);

    const done = await createIssue(fixture, { title: "child done", statusCategory: "DONE" });
    const todoA = await createIssue(fixture, { title: "child a" });
    const todoB = await createIssue(fixture, { title: "child b" });
    const canceled = await createIssue(fixture, {
      title: "child canceled",
      statusCategory: "CANCELED",
    });
    for (const c of [done, todoA, todoB, canceled]) {
      await prisma.issue.update({ where: { id: c.id }, data: { parentId: parent.id } });
    }

    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Tester",
        profileKey: `tester-${fixture.workspace.id.slice(-8)}`,
      },
    });
    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: parent.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    const { focus } = await caller.myWork();
    const card = focus.find((f) => f.id === parent.id);
    expect(card).toBeDefined();
    expect(card!.childTotal).toBe(3); // done + 2 todo; canceled excluded
    expect(card!.childDone).toBe(1);
    expect(card!.latestRun?.status).toBe("ACTIVE");
    expect(card!.latestRun?.agent?.profileKey).toBe(agent.profileKey);
  });
});
