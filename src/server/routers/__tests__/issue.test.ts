import { describe, it, expect, afterAll, afterEach } from "vitest";
import { RelationKind } from "@prisma/client";
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

describe("issueRouter — blocker-aware claim + narrowing + unblocked flag", () => {
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
    await expect(caller.claim({ issueId: outScope.id })).rejects.toThrow(
      /scope/i,
    );
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
    expect(blueRows.map((r) => r.issueId).sort()).toEqual(
      [a.id, b.id, c.id].sort(),
    );

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
    await expect(
      caller.bulkAssign({ issueIds: [a.id], claimedById: outsider.id }),
    ).rejects.toThrow(/member/i);
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
