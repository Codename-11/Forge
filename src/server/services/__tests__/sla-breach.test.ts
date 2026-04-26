import { describe, it, expect, afterAll, afterEach } from "vitest";
import { EventKind } from "@prisma/client";
import { sweepSlaBreaches } from "@/server/services/sla-breach";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the SLA-breach sweep. Mirrors stale-work.test.ts —
 * real Postgres, no mocks, one workspace per test so the tenant-scoped
 * sweep doesn't cross-talk in parallel runs.
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

async function enableSla(workspaceId: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { slaEnforcementEnabled: true },
  });
}

/**
 * Force `Issue.createdAt` to a past timestamp + set `slaMinutes`. Prisma
 * doesn't let us write `createdAt` directly via update, so drop to raw
 * SQL. Same trick stale-work.test.ts uses for `updatedAt`.
 */
async function backdateIssue(
  issueId: string,
  to: Date,
  slaMinutes: number,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(
    `UPDATE "Issue" SET "createdAt" = $1, "slaMinutes" = $2 WHERE "id" = $3`,
    to,
    slaMinutes,
    issueId,
  );
}

describe("sla-breach — sweepSlaBreaches", () => {
  it("is a no-op when slaEnforcementEnabled = false", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SLA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Default of false — do not opt in.

    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000), 30);

    const res = await sweepSlaBreaches();
    expect(res.breached).not.toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_SLA_BREACH,
      },
    });
    expect(events.length).toBe(0);
  });

  it("emits ISSUE_SLA_BREACH for an open issue past its slaMinutes", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SLB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await enableSla(fixture.workspace.id);

    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    // 90 minutes old, 30-minute SLA — overdue by ~60m.
    await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000), 30);

    const res = await sweepSlaBreaches();
    expect(res.breached).toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_SLA_BREACH,
        subjectType: "issue",
        subjectId: issue.id,
      },
    });
    expect(events.length).toBe(1);
    const payload = events[0].payload as {
      slaMinutes: number;
      breachedByMinutes: number;
      priority: string;
    };
    expect(payload.slaMinutes).toBe(30);
    expect(payload.breachedByMinutes).toBeGreaterThanOrEqual(59);
    expect(payload.breachedByMinutes).toBeLessThanOrEqual(61);
    expect(payload.priority).toBeDefined();
  });

  it("ignores issues in DONE or CANCELED", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SLC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await enableSla(fixture.workspace.id);

    const ids: string[] = [];
    for (const cat of ["DONE", "CANCELED"] as const) {
      const issue = await createIssue(fixture, { statusCategory: cat });
      await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000), 30);
      ids.push(issue.id);
    }

    const res = await sweepSlaBreaches();
    for (const id of ids) {
      expect(res.breached).not.toContain(id);
    }

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_SLA_BREACH,
      },
    });
    expect(events.length).toBe(0);
  });

  it("ignores issues with slaMinutes = null", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SLD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await enableSla(fixture.workspace.id);

    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    // Backdate createdAt but leave slaMinutes null.
    await prisma.$executeRawUnsafe(
      `UPDATE "Issue" SET "createdAt" = $1, "slaMinutes" = NULL WHERE "id" = $2`,
      new Date(Date.now() - 90 * 60_000),
      issue.id,
    );

    const res = await sweepSlaBreaches();
    expect(res.breached).not.toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_SLA_BREACH,
      },
    });
    expect(events.length).toBe(0);
  });

  it("is idempotent — does not re-breach within 24h", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SLE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await enableSla(fixture.workspace.id);

    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000), 30);

    const first = await sweepSlaBreaches();
    expect(first.breached).toContain(issue.id);

    const second = await sweepSlaBreaches();
    expect(second.breached).not.toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_SLA_BREACH,
        subjectType: "issue",
        subjectId: issue.id,
      },
    });
    expect(events.length).toBe(1);
  });
});
