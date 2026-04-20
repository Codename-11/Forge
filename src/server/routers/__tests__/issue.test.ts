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
