import { describe, it, expect, afterAll, afterEach } from "vitest";
import {
  AgentProvider,
  AgentRunStatus,
  DefaultIssueAssigneeMode,
  RelationKind,
} from "@prisma/client";
import { issueRouter } from "@/server/routers/issue";
import type { ApiKeyContext } from "@/server/services/api-key-auth";
import {
  buildContext,
  createIssue,
  createWorkspaceFixture,
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
  const fixture = await createWorkspaceFixture({ keyPrefix: "ISS" });
  fixtures.push(fixture);
  const ctx = await buildContext(fixture);
  const caller = issueRouter.createCaller(ctx);
  return { fixture, ctx, caller };
}

describe("issueRouter — list filtering", () => {
  it("keeps terminal statuses reachable when explicitly filtered", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const open = await createIssue(fixture, { title: "open", statusCategory: "TODO" });
    const done = await createIssue(fixture, { title: "done", statusCategory: "DONE" });
    const canceled = await createIssue(fixture, { title: "canceled", statusCategory: "CANCELED" });
    const doneStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });

    const activeOnly = await caller.list({ includeDone: false, limit: 50 });
    expect(activeOnly.items.map((row) => row.id)).toContain(open.id);
    expect(activeOnly.items.map((row) => row.id)).not.toContain(done.id);
    expect(activeOnly.items.map((row) => row.id)).not.toContain(canceled.id);

    const byCategory = await caller.list({
      statusCategories: ["DONE"],
      includeDone: false,
      limit: 50,
    });
    expect(byCategory.items.map((row) => row.id)).toEqual([done.id]);

    const byStatusId = await caller.list({
      statusId: doneStatus.id,
      includeDone: false,
      limit: 50,
    });
    expect(byStatusId.items.map((row) => row.id)).toEqual([done.id]);
  });

  it("supports first-class project and no-project filters", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const project = await prisma.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "OPS",
        name: "Operations",
        createdById: fixture.user.id,
      },
    });
    const projectIssue = await createIssue(fixture, {
      title: "project issue",
      projectId: project.id,
    });
    const unfiledIssue = await createIssue(fixture, { title: "unfiled issue" });

    const projectRows = await caller.list({
      projectIds: [project.id],
      includeDone: false,
      limit: 50,
    });
    expect(projectRows.items.map((row) => row.id)).toEqual([projectIssue.id]);

    const noProjectRows = await caller.list({
      withoutProject: true,
      includeDone: false,
      limit: 50,
    });
    expect(noProjectRows.items.map((row) => row.id)).toContain(unfiledIssue.id);
    expect(noProjectRows.items.map((row) => row.id)).not.toContain(projectIssue.id);
  });
});

describe("issueRouter — agent wake boundaries", () => {
  it("records a human status transition without resuming the assigned agent", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Metadata is not a prompt" });
    const currentIssue = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { statusId: true },
    });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Status worker",
        profileKey: `status-worker-${Date.now()}`,
      },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });
    const pausedAt = new Date(Date.now() - 60_000);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.WAITING,
        lastEventAt: pausedAt,
        currentStep: "waiting for the operator",
      },
    });
    const nextStatus = await prisma.status.findFirstOrThrow({
      where: {
        workspaceId: fixture.workspace.id,
        id: { not: currentIssue.statusId },
        category: { in: ["TODO", "IN_PROGRESS"] },
      },
    });

    await caller.update({ id: issue.id, statusId: nextStatus.id });

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe(AgentRunStatus.WAITING);
    expect(after.lastEventAt).toEqual(pausedAt);
    expect(after.currentStep).toBe("waiting for the operator");
    expect(
      await prisma.activityEvent.count({
        where: {
          workspaceId: fixture.workspace.id,
          subjectId: issue.id,
          kind: "ISSUE_STATUS_CHANGED",
        },
      }),
    ).toBe(1);
  });
});

describe("issueRouter — archive integrity", () => {
  it("archives reversibly, closes live work, clears dispatch state, and audits both directions", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Archive safely" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Archive worker",
        profileKey: "archive-worker",
      },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: {
        queued: true,
        claimedAt: new Date(),
        claimedById: fixture.user.id,
        claimedByAgentId: agent.id,
        claimExpiresAt: new Date(Date.now() + 60_000),
        snoozedUntil: new Date(Date.now() + 120_000),
        assignedAgentId: agent.id,
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    const archived = await caller.archive({ id: issue.id });
    expect(archived.archived).toBe(true);
    const row = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row).toMatchObject({
      queued: false,
      claimedAt: null,
      claimedById: null,
      claimedByAgentId: null,
      claimExpiresAt: null,
      snoozedUntil: null,
      assignedAgentId: agent.id,
    });
    expect(row.deletedAt).not.toBeNull();
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "ABANDONED",
    );
    await expect(caller.byId({ id: issue.id })).rejects.toThrow();
    expect((await caller.byId({ id: issue.id, includeArchived: true })).id).toBe(issue.id);

    const active = await caller.list({ archived: false, includeDone: true, limit: 50 });
    expect(active.items.map((item) => item.id)).not.toContain(issue.id);
    const archive = await caller.list({ archived: true, includeDone: true, limit: 50 });
    expect(archive.items.map((item) => item.id)).toContain(issue.id);

    const restored = await caller.restore({ id: issue.id });
    expect(restored.restored).toBe(true);
    const visible = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(visible.deletedAt).toBeNull();
    expect(visible.queued).toBe(false);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "ABANDONED",
    );
    const actions = await prisma.auditLog.findMany({
      where: { workspaceId: fixture.workspace.id, entity: "Issue", entityId: issue.id },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["archive", "restore"]),
    );
    expect(
      await prisma.activityEvent.count({
        where: { workspaceId: fixture.workspace.id, subjectId: issue.id, kind: "ISSUE_DELETED" },
      }),
    ).toBe(1);
  });

  it("cancels one active materialized step and rejects ambiguous active step links", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Plan-backed archive" });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Archive plan",
        status: "RUNNING",
        createdById: fixture.user.id,
      },
    });
    const step = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        issueId: issue.id,
        title: "Active work",
        position: 0,
        status: "RUNNING",
      },
    });

    await caller.archive({ id: issue.id });
    expect((await prisma.executionStep.findUniqueOrThrow({ where: { id: step.id } })).status).toBe(
      "CANCELED",
    );
    expect((await prisma.executionPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      "BLOCKED",
    );

    const ambiguousIssue = await createIssue(fixture, { title: "Ambiguous links" });
    await prisma.executionStep.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          issueId: ambiguousIssue.id,
          title: "One",
          position: 1,
          status: "TODO",
        },
        {
          workspaceId: fixture.workspace.id,
          planId: plan.id,
          issueId: ambiguousIssue.id,
          title: "Two",
          position: 2,
          status: "TODO",
        },
      ],
    });
    await expect(caller.archive({ id: ambiguousIssue.id })).rejects.toThrow(/more than one/i);
    expect(
      (await prisma.issue.findUniqueOrThrow({ where: { id: ambiguousIssue.id } })).deletedAt,
    ).toBeNull();
  });

  it("bulk archive and restore use the same lifecycle path", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const first = await createIssue(fixture, { title: "Bulk one" });
    const second = await createIssue(fixture, { title: "Bulk two" });
    await prisma.issue.updateMany({
      where: { id: { in: [first.id, second.id] } },
      data: { queued: true },
    });

    expect((await caller.bulkArchive({ ids: [first.id, second.id] })).updated).toBe(2);
    expect(
      await prisma.issue.count({
        where: { id: { in: [first.id, second.id] }, deletedAt: { not: null }, queued: false },
      }),
    ).toBe(2);
    expect((await caller.bulkRestore({ ids: [first.id, second.id] })).updated).toBe(2);
    expect(
      await prisma.issue.count({
        where: { id: { in: [first.id, second.id] }, deletedAt: null, queued: false },
      }),
    ).toBe(2);
  });

  it("assign rejects archived issues and users outside the workspace", async () => {
    const { caller, fixture } = await setup();
    const other = await createWorkspaceFixture({ keyPrefix: "ASG" });
    fixtures.push(other);
    const issue = await createIssue(fixture, { title: "Scoped assignment" });

    await expect(caller.assign({ id: issue.id, userIds: [other.user.id] })).rejects.toThrow(
      /member of this workspace/i,
    );
    await caller.archive({ id: issue.id });
    await expect(caller.assign({ id: issue.id, userIds: [fixture.user.id] })).rejects.toThrow(
      /not found/i,
    );
  });

  it("keeps archived issues read-only across active-work mutations", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Read-only archive" });
    const nextStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "IN_PROGRESS" },
    });
    await caller.archive({ id: issue.id });

    await expect(caller.update({ id: issue.id, title: "Should not change" })).rejects.toThrow();
    expect((await caller.bulkStatus({ ids: [issue.id], statusId: nextStatus.id })).count).toBe(0);
    await expect(caller.setQueued({ id: issue.id, queued: true })).rejects.toThrow();
    await expect(caller.release({ id: issue.id })).rejects.toThrow();
    await expect(
      caller.applyCommands({
        issueId: issue.id,
        commands: [{ kind: "priority", level: "high" }],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(caller.watch({ issueId: issue.id })).rejects.toThrow(/not found/i);

    const unchanged = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(unchanged.title).toBe("Read-only archive");
    expect(unchanged.queued).toBe(false);
  });
});

describe("issueRouter — blocker-aware claim + narrowing + unblocked flag", () => {
  it("byId returns only the latest agent run for the issue-detail failure banner", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "Needs failed-run banner" });
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Codex",
        profileKey: "codex",
        provider: AgentProvider.CODEX,
        status: "ONLINE",
      },
      select: { id: true },
    });

    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.STALLED,
        currentStep: "stalled after no runtime activity",
        externalRunId: null,
        startedAt: new Date("2026-06-01T00:00:00.000Z"),
        lastEventAt: new Date("2026-06-01T00:10:00.000Z"),
        finishedAt: new Date("2026-06-01T00:10:00.000Z"),
      },
    });

    const failed = await caller.byId({ id: issue.id });
    expect(failed.agentRuns).toHaveLength(1);
    expect(failed.agentRuns[0].status).toBe(AgentRunStatus.STALLED);
    expect(failed.agentRuns[0].agent.profileKey).toBe("codex");

    await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: AgentRunStatus.COMPLETED,
        currentStep: "done",
        externalRunId: "run-ok",
        startedAt: new Date("2026-06-01T01:00:00.000Z"),
        lastEventAt: new Date("2026-06-01T01:05:00.000Z"),
        finishedAt: new Date("2026-06-01T01:05:00.000Z"),
      },
    });

    const superseded = await caller.byId({ id: issue.id });
    expect(superseded.agentRuns).toHaveLength(1);
    expect(superseded.agentRuns[0].status).toBe(AgentRunStatus.COMPLETED);
  });

  it("byId keeps goal, plan, contract, and DAG context on a materialized step issue", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const dependencyIssue = await createIssue(fixture, { title: "Dependency issue" });
    const issue = await createIssue(fixture, { title: "Materialized issue" });
    const goal = await prisma.goal.create({
      data: {
        workspaceId: fixture.workspace.id,
        title: "Ship a coherent workflow",
        description: "Make isolated work understandable.",
        successCriteria: "Every issue retains its orchestration context.",
        createdById: fixture.user.id,
      },
    });
    const plan = await prisma.executionPlan.create({
      data: {
        workspaceId: fixture.workspace.id,
        goalId: goal.id,
        title: "Context propagation",
        description: "Carry context through every handoff.",
        status: "RUNNING",
        createdById: fixture.user.id,
      },
    });
    const dependency = await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        issueId: dependencyIssue.id,
        title: "Define the context",
        position: 0,
        status: "DONE",
      },
    });
    await prisma.executionStep.create({
      data: {
        workspaceId: fixture.workspace.id,
        planId: plan.id,
        issueId: issue.id,
        title: "Render the context",
        body: "Show the user why this issue exists.",
        position: 1,
        status: "READY",
        expectedOutput: "A visible context card.",
        verification: [{ id: "visible", label: "Goal and plan are visible", kind: "manual" }],
        dependsOnStepIds: [dependency.id],
      },
    });

    const detail = await caller.byId({ id: issue.id });
    expect(detail.executionSteps).toHaveLength(1);
    const context = detail.executionSteps[0];
    expect(context.body).toContain("why this issue exists");
    expect(context.expectedOutput).toBe("A visible context card.");
    expect(context.dependsOnStepIds).toEqual([dependency.id]);
    expect(context.plan.goal).toMatchObject({
      id: goal.id,
      title: "Ship a coherent workflow",
      successCriteria: "Every issue retains its orchestration context.",
    });
    expect(context.plan.steps).toHaveLength(2);
    expect(context.plan.steps[0].issue?.id).toBe(dependencyIssue.id);
    expect(context.plan.steps[1].issue?.id).toBe(issue.id);
  });

  it("queue exposes `unblocked` (true when nothing blocks the issue)", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { queued: true },
    });
    const rows = await caller.queue({ includeClaimed: true, limit: 10 });
    const match = rows.find((r) => r.id === issue.id);
    expect(match?.unblocked).toBe(true);
  });

  it("claim() skips blocked issues when picking the next candidate", async () => {
    const { caller, fixture, ctx } = await setup();
    const prisma = getPrisma();
    const blocker = await createIssue(fixture, { statusCategory: "TODO" });
    const blocked = await createIssue(fixture);
    const free = await createIssue(fixture);
    await prisma.issue.updateMany({
      where: { id: { in: [blocked.id, free.id] }, workspaceId: fixture.workspace.id },
      data: { queued: true },
    });
    // Mirrors `relation.add({kind: BLOCKS, from: blocker, to: blocked})`:
    //   BLOCKS     : from = blocker, to = blocked
    //   BLOCKED_BY : from = blocked, to = blocker
    await prisma.issueRelation.create({
      data: {
        workspaceId: fixture.workspace.id,
        fromIssueId: blocker.id,
        toIssueId: blocked.id,
        kind: RelationKind.BLOCKS,
      },
    });
    await prisma.issueRelation.create({
      data: {
        workspaceId: fixture.workspace.id,
        fromIssueId: blocked.id,
        toIssueId: blocker.id,
        kind: RelationKind.BLOCKED_BY,
      },
    });

    const result = await caller.claim({ claimTtlMinutes: 30 });
    expect("claimed" in result).toBe(true);
    const claimed = "claimed" in result ? result.claimed : null;
    expect(claimed).not.toBeNull();
    // The only eligible candidate is `free`.
    expect(claimed?.id).toBe(free.id);

    // Sanity: queue now surfaces `blocked` with unblocked=false.
    const rows = await caller.queue({ includeClaimed: true, limit: 10 });
    const blockedRow = rows.find((r) => r.id === blocked.id);
    expect(blockedRow?.unblocked).toBe(false);

    // Resolve the blocker — claim should now pick the previously-blocked issue.
    const doneStatus = await prisma.status.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, category: "DONE" },
    });
    await prisma.issue.update({
      where: { id: blocker.id },
      data: { statusId: doneStatus.id },
    });
    // Re-run claim.
    const second = await caller.claim({ claimTtlMinutes: 30 });
    const secondClaimed = "claimed" in second ? second.claimed : null;
    expect(secondClaimed?.id).toBe(blocked.id);

    // Suppress unused var warning.
    expect(ctx.workspaceId).toBe(fixture.workspace.id);
  });

  it("claim(issueId) honors apiKey narrowing", async () => {
    const { fixture, ctx } = await setup();
    const prisma = getPrisma();
    const label = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "scope", color: "#111" },
    });
    const inScope = await createIssue(fixture);
    const outScope = await createIssue(fixture);
    await prisma.issueLabel.create({
      data: { issueId: inScope.id, labelId: label.id },
    });
    await prisma.issue.updateMany({
      where: { id: { in: [inScope.id, outScope.id] } },
      data: { queued: true },
    });

    const narrowedCtx = {
      ...ctx,
      apiKey: {
        keyId: "k",
        workspaceId: fixture.workspace.id,
        userId: null,
        pluginId: null,
        scopes: ["WRITE_ISSUES"],
        projectIds: [],
        labelIds: [label.id],
        initiativeIds: [],
        linkedAgentId: null,
      } satisfies ApiKeyContext,
    };
    const caller = issueRouter.createCaller(narrowedCtx);

    // Specific id, in scope: succeeds.
    const claimed = await caller.claim({ issueId: inScope.id });
    expect("claimedAt" in claimed).toBe(true);

    // Specific id, out of scope: FORBIDDEN.
    await expect(caller.claim({ issueId: outScope.id })).rejects.toThrow(/scope/i);
  });
});

describe("issueRouter — bulkSetLabels / bulkAssign / bulkAssignAgent", () => {
  it("bulkSetLabels adds and removes labels across many issues + writes audit per issue", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const red = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "red", color: "#ef4444" },
    });
    const blue = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "blue", color: "#3b82f6" },
    });

    const a = await createIssue(fixture);
    const b = await createIssue(fixture);
    const c = await createIssue(fixture);
    // Pre-seed "red" on a + b so remove has something to do.
    await prisma.issueLabel.createMany({
      data: [
        { issueId: a.id, labelId: red.id },
        { issueId: b.id, labelId: red.id },
      ],
    });

    const res = await caller.bulkSetLabels({
      issueIds: [a.id, b.id, c.id],
      add: [blue.id],
      remove: [red.id],
    });

    expect(res.updated).toBe(3);
    expect(res.added).toBe(3); // blue added to all three
    expect(res.removed).toBe(2); // red was only on a + b

    const rows = await prisma.issueLabel.findMany({
      where: { issueId: { in: [a.id, b.id, c.id] } },
    });
    const redRows = rows.filter((r) => r.labelId === red.id);
    const blueRows = rows.filter((r) => r.labelId === blue.id);
    expect(redRows).toHaveLength(0);
    expect(blueRows.map((r) => r.issueId).sort()).toEqual([a.id, b.id, c.id].sort());

    // Audit + activity events per issue — invariant from CLAUDE.md.
    const audits = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Issue",
        action: "bulk-set-labels",
        entityId: { in: [a.id, b.id, c.id] },
      },
    });
    expect(audits).toHaveLength(3);
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: { in: [a.id, b.id, c.id] },
        kind: "ISSUE_UPDATED",
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("bulkSetLabels rejects labels from a different workspace", async () => {
    const { caller, fixture } = await setup();
    const otherFixture = await createWorkspaceFixture({ keyPrefix: "OTH" });
    fixtures.push(otherFixture);
    const prisma = getPrisma();
    const foreignLabel = await prisma.label.create({
      data: {
        workspaceId: otherFixture.workspace.id,
        name: "cross",
        color: "#000000",
      },
    });
    const a = await createIssue(fixture);

    await expect(
      caller.bulkSetLabels({
        issueIds: [a.id],
        add: [foreignLabel.id],
        remove: [],
      }),
    ).rejects.toThrow(/do not belong|workspace/i);
  });

  it("bulkSetLabels is a no-op on empty issueIds", async () => {
    const { caller } = await setup();
    const res = await caller.bulkSetLabels({
      issueIds: [],
      add: [],
      remove: [],
    });
    expect(res).toEqual({ updated: 0, added: 0, removed: 0 });
  });

  it("bulkAssign sets and clears claimedById across issues + writes audit per issue", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const a = await createIssue(fixture);
    const b = await createIssue(fixture);

    const assigned = await caller.bulkAssign({
      issueIds: [a.id, b.id],
      claimedById: fixture.secondUser.id,
    });
    expect(assigned.updated).toBe(2);
    const afterAssign = await prisma.issue.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { id: true, claimedById: true, claimedAt: true },
    });
    for (const row of afterAssign) {
      expect(row.claimedById).toBe(fixture.secondUser.id);
      expect(row.claimedAt).not.toBeNull();
    }

    // Audit events written per issue.
    const audits = await prisma.auditLog.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Issue",
        action: "bulk-assign",
        entityId: { in: [a.id, b.id] },
      },
    });
    expect(audits).toHaveLength(2);

    // Null releases.
    const cleared = await caller.bulkAssign({
      issueIds: [a.id, b.id],
      claimedById: null,
    });
    expect(cleared.updated).toBe(2);
    const afterClear = await prisma.issue.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { claimedById: true, claimedAt: true },
    });
    for (const row of afterClear) {
      expect(row.claimedById).toBeNull();
      expect(row.claimedAt).toBeNull();
    }
  });

  it("bulkAssign rejects non-members", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    // Bystander user with no membership in `fixture.workspace`.
    const outsider = await prisma.user.create({
      data: { email: `outsider-${Date.now()}@example.com` },
    });
    const a = await createIssue(fixture);
    await expect(caller.bulkAssign({ issueIds: [a.id], claimedById: outsider.id })).rejects.toThrow(
      /member/i,
    );
    await prisma.user.delete({ where: { id: outsider.id } }).catch(() => {});
  });

  it("bulkAssign is a no-op on empty issueIds", async () => {
    const { caller } = await setup();
    const res = await caller.bulkAssign({ issueIds: [], claimedById: null });
    expect(res).toEqual({ updated: 0 });
  });

  it("bulkAssignAgent sets and clears assignedAgentId + emits AGENT_ASSIGNED per issue", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Bulk Bot",
        profileKey: `bulk-bot-${Date.now()}`,
      },
    });
    const a = await createIssue(fixture);
    const b = await createIssue(fixture);

    const res = await caller.bulkAssignAgent({
      issueIds: [a.id, b.id],
      assignedAgentId: agent.id,
    });
    expect(res.updated).toBe(2);

    const after = await prisma.issue.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { assignedAgentId: true },
    });
    for (const row of after) {
      expect(row.assignedAgentId).toBe(agent.id);
    }

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "issue",
        subjectId: { in: [a.id, b.id] },
        kind: "AGENT_ASSIGNED",
      },
    });
    expect(events).toHaveLength(2);

    // Null clears.
    const cleared = await caller.bulkAssignAgent({
      issueIds: [a.id, b.id],
      assignedAgentId: null,
    });
    expect(cleared.updated).toBe(2);
    const clearedRows = await prisma.issue.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { assignedAgentId: true },
    });
    for (const row of clearedRows) {
      expect(row.assignedAgentId).toBeNull();
    }
  });

  it("bulkAssignAgent rejects cross-workspace agents", async () => {
    const { caller, fixture } = await setup();
    const otherFixture = await createWorkspaceFixture({ keyPrefix: "OT2" });
    fixtures.push(otherFixture);
    const prisma = getPrisma();
    const foreignAgent = await prisma.agent.create({
      data: {
        workspaceId: otherFixture.workspace.id,
        name: "Foreign",
        profileKey: `foreign-${Date.now()}`,
      },
    });
    const a = await createIssue(fixture);
    await expect(
      caller.bulkAssignAgent({
        issueIds: [a.id],
        assignedAgentId: foreignAgent.id,
      }),
    ).rejects.toThrow(/workspace/i);
  });

  it("bulkAssignAgent is a no-op on empty issueIds", async () => {
    const { caller } = await setup();
    const res = await caller.bulkAssignAgent({
      issueIds: [],
      assignedAgentId: null,
    });
    expect(res).toEqual({ updated: 0 });
  });

  it("bulk mutations silently ignore issues from other workspaces", async () => {
    const { caller, fixture } = await setup();
    const otherFixture = await createWorkspaceFixture({ keyPrefix: "OT3" });
    fixtures.push(otherFixture);
    const prisma = getPrisma();
    const label = await prisma.label.create({
      data: { workspaceId: fixture.workspace.id, name: "x", color: "#123456" },
    });
    const ours = await createIssue(fixture);
    const theirs = await createIssue(otherFixture);

    const res = await caller.bulkSetLabels({
      issueIds: [ours.id, theirs.id],
      add: [label.id],
      remove: [],
    });
    // Only our workspace's issue counts.
    expect(res.updated).toBe(1);
    const rows = await prisma.issueLabel.findMany({
      where: { labelId: label.id },
    });
    expect(rows.map((r) => r.issueId)).toEqual([ours.id]);
  });
});

describe("issueRouter — auto-watch on create / assign / agent-assign", () => {
  it("create auto-watches the human author", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({
      title: "Issue I should watch",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });
    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, userId: fixture.user.id },
    });
    expect(watcher).not.toBeNull();
    expect(watcher?.workspaceId).toBe(fixture.workspace.id);
  });

  it("create auto-watches a pre-assigned agent (via assignedAgentId)", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: "victor",
      },
    });
    const created = await caller.create({
      title: "Pre-assigned to agent",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
      assignedAgentId: agent.id,
    });
    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, agentId: agent.id },
    });
    expect(watcher).not.toBeNull();
  });

  it("create auto-watches initial human assignees", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({
      title: "Initial assignee",
      assigneeIds: [fixture.secondUser.id],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });
    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, userId: fixture.secondUser.id },
    });
    expect(watcher).not.toBeNull();
  });

  it("create applies the workspace default human assignee when none is supplied", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: {
        defaultIssueAssigneeMode: DefaultIssueAssigneeMode.USER,
        defaultIssueAssigneeUserId: fixture.secondUser.id,
      },
    });

    const created = await caller.create({
      title: "Default-assigned",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });

    expect(created.assignees.map((a) => a.userId)).toEqual([fixture.secondUser.id]);
    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, userId: fixture.secondUser.id },
    });
    expect(watcher).not.toBeNull();
  });

  it("create keeps explicit human assignees over the workspace default", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: {
        defaultIssueAssigneeMode: DefaultIssueAssigneeMode.USER,
        defaultIssueAssigneeUserId: fixture.secondUser.id,
      },
    });

    const created = await caller.create({
      title: "Explicitly assigned",
      assigneeIds: [fixture.user.id],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });

    expect(created.assignees.map((a) => a.userId)).toEqual([fixture.user.id]);
  });

  it("create can default human assignment to the issue creator", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: {
        defaultIssueAssigneeMode: DefaultIssueAssigneeMode.CREATOR,
        defaultIssueAssigneeUserId: null,
      },
    });

    const created = await caller.create({
      title: "Creator assigned",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });

    expect(created.assignees.map((a) => a.userId)).toEqual([fixture.user.id]);
  });

  it("create via agent-linked API key auto-watches the agent (not the human key owner)", async () => {
    const { ctx, fixture } = await setup();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Mizu",
        profileKey: "mizu",
      },
    });
    const agentCtx = {
      ...ctx,
      apiKey: {
        keyId: "k",
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        pluginId: null,
        scopes: ["WRITE_ISSUES"],
        projectIds: [],
        labelIds: [],
        initiativeIds: [],
        linkedAgentId: agent.id,
      } satisfies ApiKeyContext,
    };
    const agentCaller = issueRouter.createCaller(agentCtx);
    const created = await agentCaller.create({
      title: "Agent-created issue",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });
    const agentWatcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, agentId: agent.id },
    });
    expect(agentWatcher).not.toBeNull();
    // The human key owner is NOT auto-watched — the agent acted.
    const userWatcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, userId: fixture.user.id },
    });
    expect(userWatcher).toBeNull();
  });

  it("assign upserts watcher rows for newly-added human assignees", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({
      title: "Reassign",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });
    // Clear the auto-watch on the author so we can isolate the assign behavior.
    await prisma.issueWatcher.deleteMany({
      where: { issueId: created.id, userId: fixture.user.id },
    });

    await caller.assign({ id: created.id, userIds: [fixture.secondUser.id] });
    const watchers = await prisma.issueWatcher.findMany({
      where: { issueId: created.id, userId: { not: null } },
    });
    const watcherUserIds = new Set(watchers.map((w) => w.userId));
    expect(watcherUserIds.has(fixture.secondUser.id)).toBe(true);
  });

  it("assign does NOT downgrade an existing watcher when their assignment is removed", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const created = await caller.create({
      title: "Sticky",
      assigneeIds: [fixture.secondUser.id],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });
    // Sanity: secondUser is now both assigned and watching.
    const before = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, userId: fixture.secondUser.id },
    });
    expect(before).not.toBeNull();

    // Remove their assignment by re-assigning to nobody.
    await caller.assign({ id: created.id, userIds: [] });
    // Watcher row should still exist — once watching, stays watching.
    const after = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, userId: fixture.secondUser.id },
    });
    expect(after).not.toBeNull();
  });

  it("update with new assignedAgentId upserts an agent watcher", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor 2",
        profileKey: "victor2",
      },
    });
    const created = await caller.create({
      title: "Agent assign via update",
      assigneeIds: [],
      labelIds: [],
      priority: "NONE",
      kind: "ISSUE",
    });
    await caller.update({ id: created.id, assignedAgentId: agent.id });
    const watcher = await prisma.issueWatcher.findFirst({
      where: { issueId: created.id, agentId: agent.id },
    });
    expect(watcher).not.toBeNull();
  });
});

describe("issueRouter — per-issue SLA target", () => {
  it("sets, changes, and clears slaMinutes via update", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "sla target" });

    // Set
    await caller.update({ id: issue.id, slaMinutes: 240 });
    let row = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.slaMinutes).toBe(240);

    // Change
    await caller.update({ id: issue.id, slaMinutes: 1440 });
    row = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.slaMinutes).toBe(1440);

    // Clear (null)
    await caller.update({ id: issue.id, slaMinutes: null });
    row = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.slaMinutes).toBeNull();
  });

  it("rejects a zero / negative SLA target", async () => {
    const { caller, fixture } = await setup();
    const issue = await createIssue(fixture, { title: "bad sla" });
    await expect(caller.update({ id: issue.id, slaMinutes: 0 })).rejects.toThrow();
  });

  it("leaves slaMinutes untouched when omitted from an unrelated patch", async () => {
    const { caller, fixture } = await setup();
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { title: "keep sla" });
    await caller.update({ id: issue.id, slaMinutes: 480 });
    await caller.update({ id: issue.id, title: "keep sla (renamed)" });
    const row = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.slaMinutes).toBe(480);
  });
});
