import { describe, it, expect, afterAll, afterEach } from "vitest";
import { timeEntryRouter } from "@/server/routers/timeEntry";
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "TIM" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = timeEntryRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("timeEntryRouter", () => {
  it("start() then running() returns that entry; a second start rejects", async () => {
    const { caller, fixture } = await setup();
    const issue = await createIssue(fixture, { title: "work" });
    const entry = await caller.start({ issueId: issue.id, billable: false });
    expect(entry.endedAt).toBeNull();
    const running = await caller.running();
    expect(running?.id).toBe(entry.id);

    await expect(caller.start({})).rejects.toThrow(/running/i);
  });

  it("stop() marks endedAt and running() is null afterward", async () => {
    const { caller } = await setup();
    const entry = await caller.start({});
    const stopped = await caller.stop({ entryId: entry.id });
    expect(stopped.endedAt).not.toBeNull();
    expect(await caller.running()).toBeNull();
  });

  it("summary() groups by issue with totals", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issueA = await createIssue(fixture, { title: "A" });
    const issueB = await createIssue(fixture, { title: "B" });
    const now = new Date();

    // Seed closed entries directly so we can control startedAt / endedAt.
    await prisma.timeEntry.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          issueId: issueA.id,
          startedAt: new Date(now.getTime() - 60 * 60 * 1000),
          endedAt: now,
          billable: true,
          hourlyRate: 100,
        },
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          issueId: issueB.id,
          startedAt: new Date(now.getTime() - 30 * 60 * 1000),
          endedAt: now,
          billable: false,
        },
      ],
    });

    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 60 * 1000);
    const summary = await caller.summary({ from, to, groupBy: "issue" });
    expect(summary.totalMinutes).toBe(90);
    // 60 min billable at $100/h = $100
    expect(summary.totalBillableAmount).toBeCloseTo(100, 1);
    expect(summary.buckets).toHaveLength(2);
    const aBucket = summary.buckets.find((b) => b.key === issueA.id);
    const bBucket = summary.buckets.find((b) => b.key === issueB.id);
    expect(aBucket?.minutes).toBe(60);
    expect(bBucket?.minutes).toBe(30);
  });

  it("update() edits description + billable; delete() removes", async () => {
    const { caller } = await setup();
    const e = await caller.start({});
    await caller.stop({ entryId: e.id });
    const updated = await caller.update({
      entryId: e.id,
      description: "notes",
      billable: true,
      hourlyRate: 50,
    });
    expect(updated.description).toBe("notes");
    expect(updated.billable).toBe(true);

    await caller.delete({ entryId: e.id });
    const list = await caller.list();
    expect(list.map((x) => x.id)).not.toContain(e.id);
  });

  it("exportCsv() produces a header + row per entry", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const now = new Date();
    await prisma.timeEntry.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        startedAt: new Date(now.getTime() - 30 * 60 * 1000),
        endedAt: now,
        billable: true,
        hourlyRate: 80,
        description: "pair, debug",
      },
    });

    const csv = await caller.exportCsv({
      from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      to: new Date(now.getTime() + 60 * 1000),
    });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("date");
    expect(lines[0]).toContain("minutes");
    expect(lines[0]).toContain("amount");
    expect(lines).toHaveLength(2);
    // Description contains a comma so it must be quoted.
    expect(lines[1]).toMatch(/"pair, debug"/);
  });
});
