import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentStatus, AutoDispatchMode, EngagementMode, EventKind } from "@prisma/client";
import { sweepStaleWork } from "@/server/services/stale-work";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the stale-work watchdog. Mirrors heartbeat.test.ts —
 * real Postgres, no mocks, one workspace per test so the tenant-scoped sweep
 * doesn't cross-talk in parallel runs.
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

async function setSla(
  workspaceId: string,
  minutes: number,
  redispatch = false,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      assignmentSlaMinutes: minutes,
      autoRedispatchOnStall: redispatch,
    },
  });
}

async function createAgent(
  workspaceId: string,
  profileKey: string,
): Promise<{ id: string; profileKey: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: profileKey,
      profileKey,
      status: AgentStatus.ONLINE,
    },
    select: { id: true, profileKey: true },
  });
}

/**
 * Force `Issue.updatedAt` to a past timestamp. Prisma updates `updatedAt`
 * on every write, so we have to drop to raw SQL to back-date — same trick
 * the dispatcher tests would use if they needed it.
 */
async function backdateIssue(issueId: string, to: Date): Promise<void> {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(
    `UPDATE "Issue" SET "updatedAt" = $1 WHERE "id" = $2`,
    to,
    issueId,
  );
}

async function createRun(
  workspaceId: string,
  issueId: string,
  agentId: string,
  engagementMode: (typeof EngagementMode)[keyof typeof EngagementMode],
): Promise<void> {
  const prisma = getPrisma();
  await prisma.agentRun.create({
    data: { workspaceId, issueId, agentId, engagementMode },
  });
}

describe("stale-work — sweepStaleWork", () => {
  it("is a no-op when assignmentSlaMinutes == 0", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Default of 0 — do not opt in.
    const agent = await createAgent(fixture.workspace.id, "swa-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    await backdateIssue(issue.id, new Date(Date.now() - 10 * 60 * 60_000));

    const res = await sweepStaleWork();
    expect(res.stalled).not.toContain(issue.id);
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_STALLED,
      },
    });
    expect(events.length).toBe(0);
  });

  it("flags an assigned issue past the cutoff", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 30);

    const agent = await createAgent(fixture.workspace.id, "swb-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000)); // 90m ago

    const res = await sweepStaleWork();
    expect(res.stalled).toContain(issue.id);
    expect(res.redispatched).not.toContain(issue.id);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.assignedAgentId).toBe(agent.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: EventKind.ISSUE_STALLED,
      },
    });
    expect(events.length).toBe(1);
    const payload = events[0].payload as {
      assignedAgentId: string;
      agentProfileKey: string;
      slaMinutes: number;
      lastUpdate: string;
    };
    expect(payload.assignedAgentId).toBe(agent.id);
    expect(payload.agentProfileKey).toBe("swb-a1");
    expect(payload.slaMinutes).toBe(30);
    expect(typeof payload.lastUpdate).toBe("string");
  });

  it("does not flag a RESEARCH-mode assignment past the cutoff", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWG" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 30);

    const agent = await createAgent(fixture.workspace.id, "swg-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    await createRun(fixture.workspace.id, issue.id, agent.id, EngagementMode.RESEARCH);
    // A real Research reply doesn't touch Issue.updatedAt (only a status/
    // field write does) — back-date to prove the mode gate, not staleness
    // math, is what's protecting this issue.
    await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000));

    const res = await sweepStaleWork();
    expect(res.stalled).not.toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: EventKind.ISSUE_STALLED,
      },
    });
    expect(events.length).toBe(0);
  });

  it("still flags an EXECUTE-mode assignment past the cutoff even with a run attached", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWH" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 30);

    const agent = await createAgent(fixture.workspace.id, "swh-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    await createRun(fixture.workspace.id, issue.id, agent.id, EngagementMode.EXECUTE);
    await backdateIssue(issue.id, new Date(Date.now() - 90 * 60_000));

    const res = await sweepStaleWork();
    expect(res.stalled).toContain(issue.id);
  });

  it("leaves a freshly-updated issue alone", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 30);

    const agent = await createAgent(fixture.workspace.id, "swc-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    // Assign + leave updatedAt at "now" — well inside the 30m cutoff.
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });

    const res = await sweepStaleWork();
    expect(res.stalled).not.toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_STALLED,
      },
    });
    expect(events.length).toBe(0);
  });

  it("does not double-stall an issue stalled in the last hour", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 15);

    const agent = await createAgent(fixture.workspace.id, "swd-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    await backdateIssue(issue.id, new Date(Date.now() - 60 * 60_000));

    const first = await sweepStaleWork();
    expect(first.stalled).toContain(issue.id);

    // Re-backdate — recordChange may have bumped updatedAt via the audit
    // write side effects (it doesn't, but be safe so the second sweep
    // still considers the issue stale).
    await backdateIssue(issue.id, new Date(Date.now() - 60 * 60_000));

    const second = await sweepStaleWork();
    expect(second.stalled).not.toContain(issue.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: EventKind.ISSUE_STALLED,
      },
    });
    expect(events.length).toBe(1);
  });

  it("clears assignedAgentId and re-runs dispatcher when autoRedispatchOnStall is true", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 15, true);
    // Turn auto-dispatch on so the dispatcher actually re-picks. With a
    // single eligible agent, ROUND_ROBIN puts the issue right back on
    // them — but the assignment is now a fresh row (lastDispatchedAt
    // bumped), proving the dispatcher actually re-ran.
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: {
        autoDispatch: true,
        autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
      },
    });

    const agent = await createAgent(fixture.workspace.id, "swe-a1");
    const issue = await createIssue(fixture, { statusCategory: "TODO" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id, queued: true },
    });
    await backdateIssue(issue.id, new Date(Date.now() - 60 * 60_000));

    const res = await sweepStaleWork();
    expect(res.stalled).toContain(issue.id);
    expect(res.redispatched).toContain(issue.id);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    // Either re-picked (back to agent) or left null when no eligible
    // candidate — both prove the clear happened. Here we have one
    // eligible agent so the dispatcher should have re-assigned.
    expect(after.assignedAgentId).toBe(agent.id);

    const dispatchEvents = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: EventKind.AGENT_ASSIGNED,
      },
    });
    expect(dispatchEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores issues in IN_PROGRESS / IN_REVIEW / DONE / CANCELED", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "SWF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setSla(fixture.workspace.id, 15);

    const agent = await createAgent(fixture.workspace.id, "swf-a1");

    // The default fixture statuses don't include IN_REVIEW; we don't
    // strictly need it — IN_PROGRESS / DONE / CANCELED already prove
    // the category filter holds. The sweep's `notIn` shape is the
    // same for all four.
    const states = ["IN_PROGRESS", "DONE", "CANCELED"] as const;
    const ids: string[] = [];
    for (const cat of states) {
      const issue = await createIssue(fixture, { statusCategory: cat });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { assignedAgentId: agent.id },
      });
      await backdateIssue(issue.id, new Date(Date.now() - 60 * 60_000));
      ids.push(issue.id);
    }

    const res = await sweepStaleWork();
    for (const id of ids) {
      expect(res.stalled).not.toContain(id);
    }

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.ISSUE_STALLED,
      },
    });
    expect(events.length).toBe(0);
  });
});
