import { describe, it, expect, afterAll, afterEach } from "vitest";
import { EventKind } from "@prisma/client";
import { sweepStalledRuns } from "@/server/services/agent-run-stale";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the AgentRun stale watchdog. Real Postgres, no mocks.
 * The production worker invokes this sweep; these tests pin the workspace-gated
 * semantics so UI-stale and server-auto-close behavior stay intentionally split.
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

async function createAgent(workspaceId: string, profileKey: string): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: profileKey,
      profileKey,
      status: "ONLINE",
    },
    select: { id: true },
  });
}

async function backdateRun(runId: string, to: Date): Promise<void> {
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(
    `UPDATE "AgentRun" SET "lastEventAt" = $1 WHERE "id" = $2`,
    to,
    runId,
  );
}

describe("agent-run-stale — sweepStalledRuns", () => {
  it("is a no-op when agentRunStaleMinutes == 0", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "ars-a1");
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });
    await backdateRun(run.id, new Date(Date.now() - 2 * 60 * 60_000));

    const res = await sweepStalledRuns();

    expect(res.stalled).not.toContain(run.id);
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("ACTIVE");
  });

  it("closes active runs older than the workspace threshold", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ART" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { agentRunStaleMinutes: 30 },
    });
    const agent = await createAgent(fixture.workspace.id, "art-a1");
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
        currentStep: "running fixture",
      },
    });
    await backdateRun(run.id, new Date(Date.now() - 90 * 60_000));

    const res = await sweepStalledRuns();

    expect(res.stalled).toContain(run.id);
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("STALLED");
    expect(after.summary).toContain("last step: running fixture");
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        kind: EventKind.AGENT_RUN_STALLED,
        subjectId: run.id,
      },
    });
    expect(events).toHaveLength(1);
  });
});
