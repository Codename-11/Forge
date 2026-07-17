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
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { agentRunStaleMinutes: 0 },
    });
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

  it("skips WAITING runs — patient agents aren't classified as dead", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARW" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { agentRunStaleMinutes: 30 },
    });
    const agent = await createAgent(fixture.workspace.id, "arw-a1");
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "WAITING",
        currentStep: "Waiting on credentials",
      },
    });
    // Backdate well past the stale threshold — a stale-ACTIVE run with
    // the same lastEventAt would absolutely be closed.
    await backdateRun(run.id, new Date(Date.now() - 6 * 60 * 60_000));

    const res = await sweepStalledRuns();

    expect(res.stalled).not.toContain(run.id);
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("WAITING");
  });

  it("marks a quiet MCP connection unconfirmed without declaring its run stalled", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARM" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { agentRunStaleMinutes: 30 },
    });
    const agent = await createAgent(fixture.workspace.id, "arm-mcp");
    const connection = await prisma.agentConnection.create({
      data: {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        kind: "MCP_CLIENT",
        livenessModel: "LEASE",
        status: "ACTIVE",
        confidence: "CONFIRMED",
        instanceKey: `test-${Date.now()}`,
      },
    });
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        connectionId: connection.id,
        lifecycleConfidence: "CONFIRMED",
        status: "ACTIVE",
      },
    });
    await backdateRun(run.id, new Date(Date.now() - 90 * 60_000));

    const result = await sweepStalledRuns();

    expect(result.stalled).not.toContain(run.id);
    expect(result.quiet).toContain(run.id);
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({ status: "ACTIVE", lifecycleConfidence: "UNCONFIRMED" });
    await expect(
      prisma.agentConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({ status: "QUIET", confidence: "UNCONFIRMED" });
  });

  it("reconciles only passive post-merge MCP comment runs without duplicating comments", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARP" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { agentRunStaleMinutes: 30 },
    });
    const agent = await createAgent(fixture.workspace.id, "arp-mcp");
    const connection = await prisma.agentConnection.create({
      data: {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        kind: "MCP_CLIENT",
        livenessModel: "LEASE",
        status: "QUIET",
        confidence: "UNCONFIRMED",
        instanceKey: `passive-${Date.now()}`,
      },
    });
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const mergedAt = new Date(Date.now() - 2 * 60 * 60_000);
    await prisma.workSession.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        ownerAgentId: agent.id,
        source: "MCP",
        status: "MERGED",
        repoFullName: "acme/forge",
        branch: "codex/passive-mcp",
        baseBranch: "main",
        mergedAt,
        lastHeartbeatAt: mergedAt,
      },
    });
    const commentAt = new Date(Date.now() - 90 * 60_000);
    const comment = await prisma.comment.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        authorId: fixture.user.id,
        authoringAgentId: agent.id,
        kind: "BODY",
        body: "Merged and verified in GitHub.",
        createdAt: commentAt,
        updatedAt: commentAt,
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        connectionId: connection.id,
        status: "ACTIVE",
        lifecycleConfidence: "UNCONFIRMED",
        startedAt: new Date(commentAt.getTime() + 500),
        lastEventAt: new Date(commentAt.getTime() + 500),
        outputStartedAt: new Date(commentAt.getTime() + 500),
      },
    });
    await prisma.agentRunEvent.create({
      data: {
        workspaceId: fixture.workspace.id,
        runId: run.id,
        connectionId: connection.id,
        kind: "STARTED",
      },
    });

    const result = await sweepStalledRuns();

    expect(result.reconciledPassiveMcp).toContain(run.id);
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({
      status: "COMPLETED",
      engagementMode: "DISCUSS",
      completionMeta: {
        completionCommentId: comment.id,
        terminalCommentId: comment.id,
        lifecycleReconciliation: { kind: "PASSIVE_MCP_METADATA" },
      },
    });
    expect(await prisma.comment.count({ where: { issueId: issue.id } })).toBe(1);
  });

  it("keeps a post-merge MCP run active when it has explicit work evidence", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ARE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.workspace.update({
      where: { id: fixture.workspace.id },
      data: { agentRunStaleMinutes: 30 },
    });
    const agent = await createAgent(fixture.workspace.id, "are-mcp");
    const connection = await prisma.agentConnection.create({
      data: {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        kind: "MCP_CLIENT",
        livenessModel: "LEASE",
        status: "QUIET",
        confidence: "UNCONFIRMED",
        instanceKey: `explicit-${Date.now()}`,
      },
    });
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    await prisma.workSession.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        ownerAgentId: agent.id,
        source: "MCP",
        status: "MERGED",
        repoFullName: "acme/forge",
        branch: "codex/real-mcp",
        baseBranch: "main",
        mergedAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        connectionId: connection.id,
        status: "ACTIVE",
        currentStep: "Awaiting device verification",
        externalRunId: null,
      },
    });
    await backdateRun(run.id, new Date(Date.now() - 90 * 60_000));
    await prisma.agentRunEvent.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          runId: run.id,
          connectionId: connection.id,
          kind: "STARTED",
        },
        {
          workspaceId: fixture.workspace.id,
          runId: run.id,
          connectionId: connection.id,
          kind: "STATUS",
        },
      ],
    });

    const result = await sweepStalledRuns();

    expect(result.reconciledPassiveMcp).not.toContain(run.id);
    await expect(
      prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({
      status: "ACTIVE",
      currentStep: "Awaiting device verification",
    });
  });
});
