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
 * Rule-layer coverage for `maybeAutoDispatch`. Mirrors the shape of
 * `dispatcher.test.ts` — real Postgres via the shared fixture helpers,
 * one workspace per test so the suite can run in parallel.
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

async function setDispatch(
  workspaceId: string,
  patch: Partial<{
    autoDispatch: boolean;
    autoDispatchMode: AutoDispatchMode;
  }>,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.update({ where: { id: workspaceId }, data: patch });
}

async function createAgent(
  workspaceId: string,
  opts: {
    profileKey: string;
    capabilities?: string[];
    maxConcurrent?: number;
    status?: AgentStatus;
    archived?: boolean;
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
      archivedAt: opts.archived ? new Date() : null,
      lastDispatchedAt: opts.lastDispatchedAt ?? null,
    },
    select: { id: true },
  });
}

async function createRule(
  workspaceId: string,
  opts: {
    name: string;
    targetAgentId: string;
    order: number;
    priority?: Priority | null;
    labelId?: string | null;
    projectId?: string | null;
    enabled?: boolean;
  },
): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.dispatchRule.create({
    data: {
      workspaceId,
      name: opts.name,
      order: opts.order,
      targetAgentId: opts.targetAgentId,
      priority: opts.priority ?? null,
      labelId: opts.labelId ?? null,
      projectId: opts.projectId ?? null,
      enabled: opts.enabled ?? true,
    },
    select: { id: true },
  });
}

describe("dispatcher — DispatchRule layer", () => {
  it("priority-only rule fires and picks the declared target", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const victor = await createAgent(fixture.workspace.id, {
      profileKey: "dra-victor",
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "dra-mizu",
      lastDispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const rule = await createRule(fixture.workspace.id, {
      name: "urgent → victor",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: victor.id,
    });

    const issue = await createIssue(fixture, { title: "dra" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(victor.id);
    expect(res.reason).toBe(`rule:${rule.id}`);

    // Event payload carries ruleId + mode=RULE.
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
      mode: string;
      ruleId: string;
    };
    expect(payload.mode).toBe("RULE");
    expect(payload.ruleId).toBe(rule.id);
  });

  it("label-only rule fires when the issue carries that label", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const mizu = await createAgent(fixture.workspace.id, {
      profileKey: "drb-mizu",
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "drb-other",
      lastDispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const opsLabel = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "ops", color: "#abc" },
    });
    const rule = await createRule(fixture.workspace.id, {
      name: "ops → mizu",
      order: 0,
      labelId: opsLabel.id,
      targetAgentId: mizu.id,
    });

    const issue = await createIssue(fixture, { title: "drb" });
    await prisma.issueLabel.create({
      data: { issueId: issue.id, labelId: opsLabel.id },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(mizu.id);
    expect(res.reason).toBe(`rule:${rule.id}`);
  });

  it("project-only rule fires when the issue belongs to that project", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const mizu = await createAgent(fixture.workspace.id, {
      profileKey: "drp-mizu",
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "drp-other",
      lastDispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "GRW",
        name: "Growth",
        createdById: fixture.user.id,
      },
    });
    const rule = await createRule(fixture.workspace.id, {
      name: "project:Growth → mizu",
      order: 0,
      projectId: project.id,
      targetAgentId: mizu.id,
    });

    const issue = await createIssue(fixture, {
      title: "drp",
      projectId: project.id,
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(mizu.id);
    expect(res.reason).toBe(`rule:${rule.id}`);
  });

  it("multiple rules: lowest `order` wins", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const first = await createAgent(fixture.workspace.id, {
      profileKey: "drc-first",
    });
    const second = await createAgent(fixture.workspace.id, {
      profileKey: "drc-second",
    });
    const firstRule = await createRule(fixture.workspace.id, {
      name: "urgent → first",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: first.id,
    });
    await createRule(fixture.workspace.id, {
      name: "urgent → second",
      order: 5,
      priority: Priority.URGENT,
      targetAgentId: second.id,
    });

    const issue = await createIssue(fixture, { title: "drc" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(first.id);
    expect(res.reason).toBe(`rule:${firstRule.id}`);
  });

  it("disabled rule is skipped and the next rule fires", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const first = await createAgent(fixture.workspace.id, {
      profileKey: "drd-first",
    });
    const second = await createAgent(fixture.workspace.id, {
      profileKey: "drd-second",
    });
    await createRule(fixture.workspace.id, {
      name: "urgent → first (off)",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: first.id,
      enabled: false,
    });
    const secondRule = await createRule(fixture.workspace.id, {
      name: "urgent → second",
      order: 5,
      priority: Priority.URGENT,
      targetAgentId: second.id,
    });

    const issue = await createIssue(fixture, { title: "drd" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(second.id);
    expect(res.reason).toBe(`rule:${secondRule.id}`);
  });

  it("first-match target OFFLINE → falls through to mode-based selection", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    // Target of the rule is OFFLINE — ineligible. Another agent is online
    // and should be picked by round-robin fallback.
    const sleeper = await createAgent(fixture.workspace.id, {
      profileKey: "dre-sleeper",
      status: AgentStatus.OFFLINE,
    });
    const awake = await createAgent(fixture.workspace.id, {
      profileKey: "dre-awake",
    });
    const rule = await createRule(fixture.workspace.id, {
      name: "urgent → sleeper",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: sleeper.id,
    });

    const issue = await createIssue(fixture, { title: "dre" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(awake.id);
    // Reason surfaces *both* the miss and the mode pick, comma-joined.
    expect(res.reason).toBe(
      `rule:${rule.id}:target-ineligible,round-robin pick`,
    );

    // Event payload records the mode we actually ran, not "RULE".
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: issue.id,
        kind: "AGENT_ASSIGNED",
      },
    });
    const payload = events[0].payload as { mode: string };
    expect(payload.mode).toBe(AutoDispatchMode.ROUND_ROBIN);
  });

  it("first-match target archived → falls through", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const gone = await createAgent(fixture.workspace.id, {
      profileKey: "drf-gone",
      archived: true,
    });
    const awake = await createAgent(fixture.workspace.id, {
      profileKey: "drf-awake",
    });
    const rule = await createRule(fixture.workspace.id, {
      name: "urgent → gone",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: gone.id,
    });

    const issue = await createIssue(fixture, { title: "drf" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(awake.id);
    expect(res.reason).toBe(
      `rule:${rule.id}:target-ineligible,round-robin pick`,
    );
  });

  it("no rule matches → mode-based selection runs unchanged", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRG" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const stale = await createAgent(fixture.workspace.id, {
      profileKey: "drg-stale",
      lastDispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await createAgent(fixture.workspace.id, {
      profileKey: "drg-fresh",
      lastDispatchedAt: new Date(),
    });
    // `decoy` must carry a newer `lastDispatchedAt` than `stale`, otherwise
    // round-robin (null sorts first) would pick decoy and we'd be
    // testing the wrong branch.
    const decoy = await createAgent(fixture.workspace.id, {
      profileKey: "drg-decoy",
      lastDispatchedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    // Rule targets URGENT; our issue is MEDIUM so the rule doesn't fire.
    await createRule(fixture.workspace.id, {
      name: "urgent → decoy",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: decoy.id,
    });

    const issue = await createIssue(fixture, { title: "drg" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.MEDIUM },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(stale.id);
    expect(res.reason).toBe("round-robin pick");
  });

  it("combined priority+label rule only fires when BOTH conditions hold", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRH" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    // `target` has a recent lastDispatchedAt so round-robin prefers
    // `fallback` when the rule misses; otherwise the null-sorts-first
    // tiebreak would hide the actual fall-through behavior we're testing.
    const target = await createAgent(fixture.workspace.id, {
      profileKey: "drh-target",
      lastDispatchedAt: new Date(),
    });
    const fallback = await createAgent(fixture.workspace.id, {
      profileKey: "drh-fallback",
      lastDispatchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const opsLabel = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "ops", color: "#abc" },
    });
    const rule = await createRule(fixture.workspace.id, {
      name: "urgent+ops → target",
      order: 0,
      priority: Priority.URGENT,
      labelId: opsLabel.id,
      targetAgentId: target.id,
    });

    // Case 1: URGENT but no `ops` label — rule misses, mode picks fallback.
    const noLabel = await createIssue(fixture, { title: "drh-1" });
    await prisma.issue.update({
      where: { id: noLabel.id },
      data: { queued: true, priority: Priority.URGENT },
    });
    const res1 = await maybeAutoDispatch(prisma, noLabel.id);
    expect(res1.agentId).toBe(fallback.id);
    expect(res1.reason).toBe("round-robin pick");

    // Case 2: URGENT + `ops` — rule fires.
    const both = await createIssue(fixture, { title: "drh-2" });
    await prisma.issueLabel.create({
      data: { issueId: both.id, labelId: opsLabel.id },
    });
    await prisma.issue.update({
      where: { id: both.id },
      data: { queued: true, priority: Priority.URGENT },
    });
    const res2 = await maybeAutoDispatch(prisma, both.id);
    expect(res2.agentId).toBe(target.id);
    expect(res2.reason).toBe(`rule:${rule.id}`);
  });

  it("rule scanning is stable: order ASC beats createdAt ASC for ties", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "DRI" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setDispatch(fixture.workspace.id, {
      autoDispatch: true,
      autoDispatchMode: AutoDispatchMode.ROUND_ROBIN,
    });
    const older = await createAgent(fixture.workspace.id, {
      profileKey: "dri-older",
    });
    const newer = await createAgent(fixture.workspace.id, {
      profileKey: "dri-newer",
    });
    // Older rule, higher order:
    await createRule(fixture.workspace.id, {
      name: "older urgent → older",
      order: 10,
      priority: Priority.URGENT,
      targetAgentId: older.id,
    });
    // Newer rule, lower order — should win:
    const winner = await createRule(fixture.workspace.id, {
      name: "newer urgent → newer",
      order: 0,
      priority: Priority.URGENT,
      targetAgentId: newer.id,
    });

    const issue = await createIssue(fixture, { title: "dri" });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true, priority: Priority.URGENT },
    });

    const res = await maybeAutoDispatch(prisma, issue.id);
    expect(res.agentId).toBe(newer.id);
    expect(res.reason).toBe(`rule:${winner.id}`);
  });
});

