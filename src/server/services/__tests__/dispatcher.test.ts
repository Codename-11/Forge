import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentStatus, AutoDispatchMode, Priority } from "@prisma/client";
import { maybeAutoDispatch } from "@/server/services/dispatcher";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the auto-dispatch service. Mirrors the MCP
 * integration tests — real Postgres via the shared fixture helpers, no
 * mocks. Each test builds its own workspace so they can run in parallel.
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

/** Flip the workspace's dispatch knobs in one shot. */
async function setDispatch(
  workspaceId: string,
  patch: Partial<{
    autoDispatch: boolean;
    autoDispatchMode: AutoDispatchMode;
    autoStartOnAssign: boolean;
    requireApprovalBeforeStart: boolean;
  }>,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.update({ where: { id: workspaceId }, data: patch });
}

/** Create an agent with the given capabilities / cap; default ONLINE. */
async function createAgent(
  workspaceId: string,
  opts: {
    profileKey: string;
    capabilities?: string[];
    maxConcurrent?: number;
    status?: AgentStatus;
    lastDispatchedAt?: Date | null;
  },
): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: opts.profileKey,
      profileKey: opts.profileKey,
      capabilities: opts.capabilities ?? [],
      maxConcurrent: opts.maxConcurrent ?? 1,
      status: opts.status ?? AgentStatus.ONLINE,
      lastDispatchedAt: opts.lastDispatchedAt ?? null,
    },
    select: { id: true },
  });
}

describe("dispatcher — maybeAutoDispatch", () => {
  it("returns null when autoDispatch is off (even if queued)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Off by default. Mode irrelevant; short-circuit on autoDispatch.
    await setDispatch(fixture.workspace.id, {
      autoDispatch: false,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    await createAgent(fixture.workspace.id, { profileKey: "a1" });
    const issue = await createIssue(fixture, { title: "dsa" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBeNull();
    expect(res.reason).toBe("auto-dispatch-off");
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.assignedAgentId).toBeNull();
  });

  it("returns null in MANUAL_ONLY mode", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.MANUAL_ONLY,
    });
    await createAgent(fixture.workspace.id, { profileKey: "b1" });
    const issue = await createIssue(fixture, { title: "dsb" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBeNull();
    expect(res.reason).toBe("manual-only");
  });

  it("returns null when the issue is already assigned", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "c1",
    });
    const other = await createAgent(fixture.workspace.id, {
      profileKey: "c2",
    });
    const issue = await createIssue(fixture, { title: "dsc" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, assignedAgentId: agent.id },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBeNull();
    expect(res.reason).toBe("already-assigned");
    // No new assignment happened to the other agent either.
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.assignedAgentId).toBe(agent.id);
    void other;
  });

  it("returns null when no candidates meet maxConcurrent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    // Single agent, cap=1, already at cap via an existing in-progress issue.
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "d1",
      maxConcurrent: 1,
    });
    const inProgress = await createIssue(fixture, {
      title: "busy",
      statusCategory: "IN_PROGRESS",
    });
    await prisma.issue.update({
      where: { id: inProgress.id },
      data: { assignedAgentId: agent.id },
    });

    // New queued issue needs dispatch; agent is saturated.
    const issue = await createIssue(fixture, { title: "dsd" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBeNull();
    expect(res.reason).toBe("no-candidates");
  });

  it("ROUND_ROBIN picks the agent with the older lastDispatchedAt", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const older = new Date(Date.now() - 60 * 60 * 1000);
    const newer = new Date(Date.now() - 5 * 60 * 1000);
    const stale = await createAgent(fixture.workspace.id, {
      profileKey: "e-stale",
      lastDispatchedAt: older,
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "e-fresh",
      lastDispatchedAt: newer,
    });

    const issue = await createIssue(fixture, { title: "dse" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(stale.id);

    // The picked agent's lastDispatchedAt should now be newer than both
    // original timestamps — confirming the round-robin bookkeeping.
    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(after.lastDispatchedAt!.getTime()).toBeGreaterThan(
      older.getTime(),
    );
    expect(after.lastDispatchedAt!.getTime()).toBeGreaterThan(
      newer.getTime(),
    );

    // Dispatch provenance is persisted on the AGENT_ASSIGNED payload so
    // operators can replay the decision without joining agent state.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
    });
    const dispatch = (
      event.payload as {
        dispatch: {
          mode: AutoDispatchMode;
          candidates: Array<{
            agentId: string;
            profileKey: string;
            eligible: boolean;
          }>;
          chosen: { agentId: string; profileKey: string } | null;
          reason: string;
        };
      }
    ).dispatch;
    expect(dispatch.mode).toBe(AutoDispatchMode.ROUND_ROBIN);
    expect(dispatch.reason).toBe("round-robin");
    expect(dispatch.candidates.length).toBeGreaterThan(0);
    expect(dispatch.candidates.length).toBe(2);
    expect(dispatch.chosen?.agentId).toBe(stale.id);
    expect(dispatch.chosen?.profileKey).toBe("e-stale");
    expect(
      dispatch.candidates.every((c) => c.eligible === true),
    ).toBe(true);
  });

  it("PRIORITY_MATCH prefers a capability-matched agent over a generalist", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.PRIORITY_MATCH,
    });
    // Generalist was picked very recently, so round-robin alone would
    // skip it — but even newer timestamp aside, the specialist should win
    // because its capabilities intersect `urgent`.
    const specialist = await createAgent(fixture.workspace.id, {
      profileKey: "f-specialist",
      capabilities: ["urgent"],
      lastDispatchedAt: new Date(),
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "f-generalist",
      capabilities: [],
      lastDispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const issue = await createIssue(fixture, { title: "dsf" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(specialist.id);
  });

  it("CAPABILITY_MATCH picks the agent whose capabilities overlap the issue labels", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSG" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.CAPABILITY_MATCH,
    });
    const ops = await createAgent(fixture.workspace.id, {
      profileKey: "g-ops",
      capabilities: ["ops"],
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "g-other",
      capabilities: ["research"],
    });

    const label = await prisma.label.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "ops",
        color: "#abc",
      },
    });
    const issue = await createIssue(fixture, { title: "dsg" });
    await prisma.issueLabel.create({
      data: { issueId: issue.id, labelId: label.id },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(ops.id);

    // CAPABILITY_MATCH should record per-candidate matchCount and a
    // reason string that surfaces the winning score.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
    });
    const dispatch = (
      event.payload as {
        dispatch: {
          mode: AutoDispatchMode;
          candidates: Array<{
            agentId: string;
            profileKey: string;
            matchCount?: number;
            eligible: boolean;
          }>;
          chosen: {
            agentId: string;
            profileKey: string;
            matchCount?: number;
          } | null;
          reason: string;
        };
      }
    ).dispatch;
    expect(dispatch.mode).toBe(AutoDispatchMode.CAPABILITY_MATCH);
    expect(dispatch.reason).toBe("capability-match:1");
    expect(dispatch.candidates.length).toBeGreaterThan(0);
    expect(dispatch.chosen?.agentId).toBe(ops.id);
    expect(dispatch.chosen?.profileKey).toBe("g-ops");
    expect(dispatch.chosen?.matchCount).toBe(1);
    const opsCandidate = dispatch.candidates.find(
      (c) => c.agentId === ops.id,
    );
    expect(opsCandidate?.matchCount).toBe(1);
    const otherCandidate = dispatch.candidates.find(
      (c) => c.profileKey === "g-other",
    );
    expect(otherCandidate?.matchCount).toBe(0);
  });

  it("emits AGENT_ASSIGNED with auto=true and writes the assignment", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DSH" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "h1",
    });
    const issue = await createIssue(fixture, { title: "dsh" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(agent.id);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
    });
    expect(after.assignedAgentId).toBe(agent.id);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
    });
    expect(events.length).toBe(1);
    const payload = events[0].payload as {
      agentId: string;
      auto: boolean;
      mode: string;
      previousAgentId: string | null;
    };
    expect(payload.agentId).toBe(agent.id);
    expect(payload.auto).toBe(true);
    expect(payload.mode).toBe(AutoDispatchMode.ROUND_ROBIN);
    expect(payload.previousAgentId).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Issue",
        entityId: issue.id,
        action: "auto-dispatch",
      },
    });
    expect(audit).not.toBeNull();
  });
});
