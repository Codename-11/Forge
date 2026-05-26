import { describe, it, expect, afterAll, afterEach } from "vitest";
import { inboxRouter } from "@/server/routers/inbox";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration coverage for `inbox.badge`. The badge is an *unread* signal,
 * not a live backlog total: it counts only assigned/mentioned/stalled
 * items that are new since `User.lastInboxVisitAt`. So a "visit" (which
 * the Inbox page, the "M" hotkey, and closing the bell all trigger) must
 * drop the count to zero, and fresh activity must re-raise it. A user who
 * has never visited sees the full count.
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "BDG" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const prisma = getPrisma();
  return { fixture, ctx, prisma };
}

async function assignToCaller(fixture: TestFixture, issueId: string) {
  await getPrisma().issueAssignee.create({
    data: { issueId, userId: fixture.user.id },
  });
}

describe("inboxRouter.badge", () => {
  it("counts an assigned issue when the caller has never visited", async () => {
    const { fixture, ctx } = await setup();
    const issue = await createIssue(fixture);
    await assignToCaller(fixture, issue.id);

    const caller = inboxRouter.createCaller(ctx);
    expect((await caller.badge()).count).toBe(1);
  });

  it("drops to zero once the caller visits (nothing new since)", async () => {
    const { fixture, ctx } = await setup();
    const issue = await createIssue(fixture);
    await assignToCaller(fixture, issue.id);

    const caller = inboxRouter.createCaller(ctx);
    expect((await caller.badge()).count).toBe(1);

    // Visiting after the issue's last update means it's no longer "new".
    await caller.visit();
    expect((await caller.badge()).count).toBe(0);
  });

  it("re-raises when an assigned issue is updated after the visit", async () => {
    const { fixture, ctx, prisma } = await setup();
    const issue = await createIssue(fixture);
    await assignToCaller(fixture, issue.id);

    const caller = inboxRouter.createCaller(ctx);
    await caller.visit();
    expect((await caller.badge()).count).toBe(0);

    // Touch the issue so updatedAt > lastInboxVisitAt — i.e. new activity.
    await prisma.issue.update({
      where: { id: issue.id },
      data: { updatedAt: new Date(Date.now() + 1000) },
    });
    expect((await caller.badge()).count).toBe(1);
  });
});
