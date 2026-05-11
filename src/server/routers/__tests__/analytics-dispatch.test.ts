import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  AgentStatus,
  AutoDispatchMode,
  EventKind,
  type Prisma,
} from "@prisma/client";
import { analyticsRouter } from "@/server/routers/analytics";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

/**
 * Integration tests for the dispatch analytics router.
 *
 * Strategy — seed deterministic ActivityEvent rows (AGENT_ASSIGNED,
 * ISSUE_STATUS_CHANGED, COMMENT_CREATED) with explicit `createdAt`
 * timestamps, flip the relevant Issue rows' `completedAt`, then call the
 * router and assert the aggregate. Timestamps are well-separated so
 * rounding in `mean()` stays unambiguous.
 *
 * No mocks — real Postgres via the shared helpers (per the CLAUDE.md
 * "no mocks in integration tests" rule).
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

async function createAgent(
  workspaceId: string,
  opts: { profileKey: string; capabilities?: string[] },
): Promise<{ id: string; profileKey: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: opts.profileKey,
      profileKey: opts.profileKey,
      capabilities: opts.capabilities ?? [],
      status: AgentStatus.ONLINE,
    },
    select: { id: true, profileKey: true },
  });
}

/** Insert an ActivityEvent with a chosen createdAt. */
async function insertEvent(
  workspaceId: string,
  kind: EventKind,
  issueId: string,
  createdAt: Date,
  payload: Prisma.InputJsonValue = {},
): Promise<void> {
  await getPrisma().activityEvent.create({
    data: {
      workspaceId,
      kind,
      actorId: null,
      subjectType: "issue",
      subjectId: issueId,
      payload,
      createdAt,
    },
  });
}

/** Convenience — AGENT_ASSIGNED with a specific agentId + mode. */
async function insertAssign(
  workspaceId: string,
  issueId: string,
  agentId: string,
  at: Date,
  mode: AutoDispatchMode | "MANUAL" = AutoDispatchMode.ROUND_ROBIN,
): Promise<void> {
  const payload: Prisma.InputJsonValue =
    mode === "MANUAL"
      ? { agentId, previousAgentId: null }
      : { agentId, previousAgentId: null, auto: true, mode };
  await insertEvent(
    workspaceId,
    EventKind.AGENT_ASSIGNED,
    issueId,
    at,
    payload,
  );
}

describe("analyticsRouter.dispatch.summary", () => {
  it("rolls up assignments + TTFA + TTC + throughput + mode distribution", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ADS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const ctx = await buildContext(fixture);
    const caller = analyticsRouter.createCaller(ctx);

    const agentA = await createAgent(fixture.workspace.id, {
      profileKey: "agent-a",
    });
    const agentB = await createAgent(fixture.workspace.id, {
      profileKey: "agent-b",
    });

    const doneStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });

    // Anchor: 24h ago so everything is comfortably inside the 30d window.
    const base = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ms = (minutes: number) =>
      new Date(base.getTime() + minutes * 60 * 1000);

    // ------------- Issue 1: assigned to A, commented 10m later, done 60m
    const i1 = await createIssue(fixture);
    await insertAssign(
      fixture.workspace.id,
      i1.id,
      agentA.id,
      ms(0),
      AutoDispatchMode.ROUND_ROBIN,
    );
    await insertEvent(
      fixture.workspace.id,
      EventKind.COMMENT_CREATED,
      i1.id,
      ms(10),
    );
    await insertEvent(
      fixture.workspace.id,
      EventKind.ISSUE_STATUS_CHANGED,
      i1.id,
      ms(60),
      { statusId: doneStatus.id },
    );
    await prisma.issue.update({
      where: { id: i1.id },
      data: {
        statusId: doneStatus.id,
        completedAt: ms(60),
        assignedAgentId: agentA.id,
      },
    });

    // ------------- Issue 2: assigned to A, status change at 30m, done 90m
    const i2 = await createIssue(fixture);
    await insertAssign(
      fixture.workspace.id,
      i2.id,
      agentA.id,
      ms(0),
      AutoDispatchMode.PRIORITY_MATCH,
    );
    await insertEvent(
      fixture.workspace.id,
      EventKind.ISSUE_STATUS_CHANGED,
      i2.id,
      ms(30),
      { statusId: doneStatus.id },
    );
    await prisma.issue.update({
      where: { id: i2.id },
      data: {
        statusId: doneStatus.id,
        completedAt: ms(90),
        assignedAgentId: agentA.id,
      },
    });

    // ------------- Issue 3: assigned to B, time-start at 5m, no completion
    const i3 = await createIssue(fixture);
    await insertAssign(
      fixture.workspace.id,
      i3.id,
      agentB.id,
      ms(0),
      AutoDispatchMode.CAPABILITY_MATCH,
    );
    await insertEvent(
      fixture.workspace.id,
      EventKind.ISSUE_UPDATED,
      i3.id,
      ms(5),
      { event: "time.start" },
    );
    await prisma.issue.update({
      where: { id: i3.id },
      data: { assignedAgentId: agentB.id },
    });

    // ------------- Issue 4: assigned to B, no follow-up at all, no completion
    const i4 = await createIssue(fixture);
    await insertAssign(
      fixture.workspace.id,
      i4.id,
      agentB.id,
      ms(0),
      AutoDispatchMode.ROUND_ROBIN,
    );
    await prisma.issue.update({
      where: { id: i4.id },
      data: { assignedAgentId: agentB.id },
    });

    // ------------- Issue 5: assigned to A, re-assigned to B at 20m, B
    // comments at 25m, B completes at 40m. Confirms the windowed TTFA:
    // A's "first action" must be nil (they were unassigned before any
    // of their own events landed), and B gets credit for the 5m comment.
    const i5 = await createIssue(fixture);
    await insertAssign(
      fixture.workspace.id,
      i5.id,
      agentA.id,
      ms(0),
      AutoDispatchMode.ROUND_ROBIN,
    );
    await insertAssign(
      fixture.workspace.id,
      i5.id,
      agentB.id,
      ms(20),
      "MANUAL",
    );
    await insertEvent(
      fixture.workspace.id,
      EventKind.COMMENT_CREATED,
      i5.id,
      ms(25),
    );
    await insertEvent(
      fixture.workspace.id,
      EventKind.ISSUE_STATUS_CHANGED,
      i5.id,
      ms(40),
      { statusId: doneStatus.id },
    );
    await prisma.issue.update({
      where: { id: i5.id },
      data: {
        statusId: doneStatus.id,
        completedAt: ms(40),
        assignedAgentId: agentB.id,
      },
    });

    // Sanity: 5 issues, 6 AGENT_ASSIGNED events (i5 has 2).
    const totalAssigns = await prisma.activityEvent.count({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_ASSIGNED,
      },
    });
    expect(totalAssigns).toBe(6);

    const res = await caller.dispatch.summary({});

    // --------- Totals -------------------------------------------------
    expect(res.totals.assignments).toBe(6);
    // TTFA contributions (in minutes, convert to ms for the comparison):
    //   agentA-i1: 10m, agentA-i2: 30m, agentB-i3: 5m, agentB-i5: 5m
    //   agentA-i4: 0m? no — i4 is agent B
    //   agentB-i4: NULL (no follow-up)
    //   agentA-i5 (first assign): NULL (re-assigned before any event)
    // Mean of {10, 30, 5, 5} = 12.5 minutes = 750_000 ms.
    expect(res.totals.meanTimeToFirstAction).toBe(
      Math.round(((10 + 30 + 5 + 5) / 4) * 60 * 1000),
    );

    // TTC contributions:
    //   agentA-i1: 60m, agentA-i2: 90m, agentA-i5: NULL (re-assigned away),
    //   agentB-i5: 40m (completed in-window, 40m - 20m = 20m),
    //   agentB-i3/i4: NULL (still open).
    // Wait — i5 completedAt is ms(40). agentB-i5 assign is ms(20). So
    // window = [20, ∞) ∩ (completedAt=40 < next-assign=∞) → 20m. Good.
    // agentA-i5 assign is ms(0), next-assign=ms(20), completedAt=40 ≥ 20
    // → excluded.
    // Mean {60, 90, 20} = 56.67m. ms = 56.67 * 60_000 rounded.
    const expectedTtc = Math.round(((60 + 90 + 20) / 3) * 60 * 1000);
    expect(res.totals.meanTimeToCompletion).toBe(expectedTtc);

    // Throughput (last 7d) — 3 issues completed with an assignedAgentId.
    // i1, i2 (agentA) and i5 (agentB).
    expect(res.totals.throughputLast7d).toBe(3);

    // --------- Mode distribution -------------------------------------
    // ROUND_ROBIN: i1, i4, i5-first → 3
    // PRIORITY_MATCH: i2 → 1
    // CAPABILITY_MATCH: i3 → 1
    // MANUAL_ONLY: i5-second (no `mode` key) → 1
    expect(res.modeDistribution).toEqual({
      ROUND_ROBIN: 3,
      PRIORITY_MATCH: 1,
      CAPABILITY_MATCH: 1,
      MANUAL_ONLY: 1,
    });

    // --------- Per-agent ---------------------------------------------
    const rowA = res.perAgent.find((r) => r.agentId === agentA.id);
    const rowB = res.perAgent.find((r) => r.agentId === agentB.id);

    // Agent A: assigned on i1, i2, i5-first = 3 assignments.
    expect(rowA?.assignments).toBe(3);
    // TTFA for A: {10m, 30m} → 20m; i5-first excluded as "no action".
    expect(rowA?.meanTimeToFirstAction).toBe(
      Math.round(((10 + 30) / 2) * 60 * 1000),
    );
    expect(rowA?.assignmentsWithoutAction).toBe(1); // i5-first
    // TTC for A: {60m, 90m} → 75m; i5-first excluded as "re-assigned away".
    expect(rowA?.meanTimeToCompletion).toBe(
      Math.round(((60 + 90) / 2) * 60 * 1000),
    );
    expect(rowA?.openAssignments).toBe(1); // i5-first (excluded via re-assign)
    expect(rowA?.throughputLast7d).toBe(2); // i1, i2

    // Agent B: assigned on i3, i4, i5-second = 3 assignments.
    expect(rowB?.assignments).toBe(3);
    // TTFA for B: {5m, 5m} → 5m; i4 excluded (no action).
    expect(rowB?.meanTimeToFirstAction).toBe(5 * 60 * 1000);
    expect(rowB?.assignmentsWithoutAction).toBe(1); // i4
    // TTC for B: {20m} (i5 only); i3 + i4 still open.
    expect(rowB?.meanTimeToCompletion).toBe(20 * 60 * 1000);
    expect(rowB?.openAssignments).toBe(2);
    expect(rowB?.throughputLast7d).toBe(1); // i5 (most recent assignee)
  });

  it("narrowing by agentId filters per-agent and counts only that agent's events", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ADN" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const ctx = await buildContext(fixture);
    const caller = analyticsRouter.createCaller(ctx);

    const agentA = await createAgent(fixture.workspace.id, {
      profileKey: "agent-a-narrow",
    });
    const agentB = await createAgent(fixture.workspace.id, {
      profileKey: "agent-b-narrow",
    });
    const base = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const i1 = await createIssue(fixture);
    const i2 = await createIssue(fixture);
    await insertAssign(fixture.workspace.id, i1.id, agentA.id, base);
    await insertAssign(
      fixture.workspace.id,
      i2.id,
      agentB.id,
      new Date(base.getTime() + 1000),
    );
    await prisma.issue.update({
      where: { id: i1.id },
      data: { assignedAgentId: agentA.id },
    });
    await prisma.issue.update({
      where: { id: i2.id },
      data: { assignedAgentId: agentB.id },
    });

    const res = await caller.dispatch.summary({ agentId: agentA.id });
    expect(res.perAgent).toHaveLength(1);
    expect(res.perAgent[0].agentId).toBe(agentA.id);
    expect(res.perAgent[0].assignments).toBe(1);
    // Totals are narrowed: modeDistribution still counts only the agent's
    // assignments (1 ROUND_ROBIN for i1).
    expect(res.totals.assignments).toBe(1);
  });
});

describe("analyticsRouter.dispatch.timeseries", () => {
  it("buckets assignments and completions by day", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ADT" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const ctx = await buildContext(fixture);
    const caller = analyticsRouter.createCaller(ctx);

    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "agent-ts",
    });
    const doneStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const i1 = await createIssue(fixture);
    const i2 = await createIssue(fixture);
    const i3 = await createIssue(fixture);
    await insertAssign(fixture.workspace.id, i1.id, agent.id, twoDaysAgo);
    await insertAssign(fixture.workspace.id, i2.id, agent.id, dayAgo);
    await insertAssign(fixture.workspace.id, i3.id, agent.id, dayAgo);
    await prisma.issue.update({
      where: { id: i1.id },
      data: {
        completedAt: twoDaysAgo,
        statusId: doneStatus.id,
        assignedAgentId: agent.id,
      },
    });
    await prisma.issue.update({
      where: { id: i2.id },
      data: {
        completedAt: dayAgo,
        statusId: doneStatus.id,
        assignedAgentId: agent.id,
      },
    });

    const res = await caller.dispatch.timeseries({ bucket: "day" });
    const totalAssigns = res.reduce((a, b) => a + b.assignments, 0);
    const totalCompletes = res.reduce((a, b) => a + b.completions, 0);
    expect(totalAssigns).toBe(3);
    expect(totalCompletes).toBe(2);
    // Two distinct days in our window → two buckets.
    expect(res.length).toBeGreaterThanOrEqual(2);
  });
});
