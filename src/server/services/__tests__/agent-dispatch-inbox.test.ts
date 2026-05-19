import { describe, it, expect, afterAll, afterEach } from "vitest";
import { EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";
import {
  ackInboxItem,
  listInbox,
  recordWakeAttempt,
  markOutputStarted,
  ensureCanonicalFromEvent,
  deriveRunDispatchState,
  deriveChatDispatchState,
  InboxForbiddenError,
} from "@/server/services/agent-dispatch-inbox";
import {
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the durable agent dispatch inbox. No mocks;
 * real Postgres. The goal is to pin the canonical-work-at-event-time
 * contract so worker.ts / audit.ts edits can't accidentally regress
 * it. The matching MCP-side coverage lives in `mcp.test.ts`; this file
 * exercises the service primitives directly.
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
  profileKey: string,
  opts: { webhookUrl?: string | null } = {},
): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: profileKey,
      profileKey,
      status: "ONLINE",
      webhookUrl: opts.webhookUrl === undefined ? "https://example.test/wake" : opts.webhookUrl,
    },
    select: { id: true },
  });
}

describe("agent-dispatch-inbox — ensureCanonicalFromEvent", () => {
  it("opens an AgentRun in the same transaction as AGENT_ASSIGNED", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "INB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "inb-a1");
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });

    await prisma.$transaction(async (tx) => {
      await recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issue.id,
        action: "assign",
        eventKind: EventKind.AGENT_ASSIGNED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { agentId: agent.id, agentProfileKey: "inb-a1" },
      });
    });

    const run = await prisma.agentRun.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });
    expect(run).not.toBeNull();
    expect(run!.acknowledgedAt).toBeNull();
    expect(run!.outputStartedAt).toBeNull();
    expect(run!.triggerKind).toBe(EventKind.AGENT_ASSIGNED);
    expect(run!.triggerEventId).not.toBeNull();
    expect(run!.assignmentEventId).toBe(run!.triggerEventId);
  });

  it("creates one run per agent for COMMENT_CREATED mentions", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "INM" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const a1 = await createAgent(fixture.workspace.id, "inm-a1");
    const a2 = await createAgent(fixture.workspace.id, "inm-a2");
    const issue = await createIssue(fixture);

    await prisma.$transaction(async (tx) => {
      await recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Comment",
        entityId: "test-comment-id",
        action: "create",
        eventKind: EventKind.COMMENT_CREATED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: {
          mentions: [
            { agentId: a1.id, profileKey: "inm-a1" },
            { agentId: a2.id, profileKey: "inm-a2" },
          ],
        },
      });
    });

    const runs = await prisma.agentRun.findMany({
      where: { workspaceId: fixture.workspace.id, issueId: issue.id, status: "ACTIVE" },
      orderBy: { agentId: "asc" },
    });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.triggerKind === EventKind.COMMENT_CREATED)).toBe(true);
    expect(runs.every((r) => r.assignmentEventId === null)).toBe(true);
  });

  it("creates the run even when the agent has no webhookUrl", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "INN" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "inn-a1", { webhookUrl: null });
    const issue = await createIssue(fixture);
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assignedAgentId: agent.id },
    });

    await prisma.$transaction(async (tx) => {
      await recordChange(tx, {
        workspaceId: fixture.workspace.id,
        actorId: fixture.user.id,
        entity: "Issue",
        entityId: issue.id,
        action: "assign",
        eventKind: EventKind.AGENT_ASSIGNED,
        subjectType: "issue",
        subjectId: issue.id,
        payload: { agentId: agent.id, agentProfileKey: "inn-a1" },
      });
    });

    const run = await prisma.agentRun.findFirst({
      where: { workspaceId: fixture.workspace.id, agentId: agent.id, status: "ACTIVE" },
    });
    expect(run).not.toBeNull();
    // Webhook delivery rows should NOT exist for an agent without webhookUrl.
    const deliveries = await prisma.webhookDelivery.count({
      where: { event: { workspaceId: fixture.workspace.id, kind: EventKind.AGENT_ASSIGNED } },
    });
    expect(deliveries).toBe(0);
  });

  it("returns empty when resolvedAgentIds is empty", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "INE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture);
    const result = await prisma.$transaction((tx) =>
      ensureCanonicalFromEvent(tx, {
        workspaceId: fixture.workspace.id,
        eventKind: EventKind.AGENT_ASSIGNED,
        eventId: "no-such-event",
        subjectType: "issue",
        subjectId: issue.id,
        actorId: fixture.user.id,
        payload: {},
        resolvedAgentIds: [],
      }),
    );
    expect(result.issueRunIds).toHaveLength(0);
    expect(result.chatMessageIds).toHaveLength(0);
  });
});

describe("agent-dispatch-inbox — ackInboxItem", () => {
  it("sets acknowledgedAt and is idempotent on a run", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "ACK" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "ack-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    const first = await prisma.$transaction((tx) =>
      ackInboxItem(tx, {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: { runId: run.id },
      }),
    );
    expect(first.alreadyAcked).toBe(false);
    expect(first.acknowledgedAt).toBeInstanceOf(Date);

    const second = await prisma.$transaction((tx) =>
      ackInboxItem(tx, {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: { runId: run.id },
      }),
    );
    expect(second.alreadyAcked).toBe(true);
    expect(second.acknowledgedAt.getTime()).toBe(first.acknowledgedAt.getTime());
  });

  it("rejects cross-agent ack attempts", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AC2" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const owner = await createAgent(fixture.workspace.id, "ac2-owner");
    const other = await createAgent(fixture.workspace.id, "ac2-other");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: owner.id,
        status: "ACTIVE",
      },
    });

    await expect(
      prisma.$transaction((tx) =>
        ackInboxItem(tx, {
          workspaceId: fixture.workspace.id,
          agentId: other.id,
          target: { runId: run.id },
        }),
      ),
    ).rejects.toBeInstanceOf(InboxForbiddenError);
  });
});

describe("agent-dispatch-inbox — recordWakeAttempt", () => {
  it("bumps wakeAttempts on every call and timestamps lastWakeAt", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "WAK" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "wak-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    await prisma.$transaction((tx) =>
      recordWakeAttempt(tx, {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: { kind: "issue", issueId: issue.id },
        deliveryId: "delivery-1",
        eventId: "event-1",
        eventKind: EventKind.AGENT_ASSIGNED,
        ok: true,
      }),
    );
    await prisma.$transaction((tx) =>
      recordWakeAttempt(tx, {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: { kind: "issue", issueId: issue.id },
        deliveryId: "delivery-2",
        eventId: "event-2",
        eventKind: EventKind.AGENT_ASSIGNED,
        ok: false,
      }),
    );

    const r = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(r.wakeAttempts).toBe(2);
    expect(r.lastWakeDeliveryId).toBe("delivery-2");
    expect(r.lastWakeAt).not.toBeNull();
  });
});

describe("agent-dispatch-inbox — listInbox", () => {
  it("returns unacked runs only when filter=unacked", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "LST" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "lst-a1");
    const i1 = await createIssue(fixture);
    const i2 = await createIssue(fixture);
    const r1 = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: i1.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });
    const r2 = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: i2.id,
        agentId: agent.id,
        status: "ACTIVE",
        acknowledgedAt: new Date(),
      },
    });

    const unacked = await listInbox(prisma, {
      workspaceId: fixture.workspace.id,
      agentId: agent.id,
      filter: "unacked",
      limit: 50,
    });
    const runIds = unacked
      .filter((i) => i.kind === "run")
      .map((i) => (i as { runId: string }).runId);
    expect(runIds).toContain(r1.id);
    expect(runIds).not.toContain(r2.id);
  });
});

describe("agent-dispatch-inbox — markOutputStarted", () => {
  it("is idempotent on a run", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "OUT" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await createAgent(fixture.workspace.id, "out-a1");
    const issue = await createIssue(fixture);
    const run = await prisma.agentRun.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        agentId: agent.id,
        status: "ACTIVE",
      },
    });

    const first = await prisma.$transaction((tx) =>
      markOutputStarted(tx, {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: { runId: run.id },
      }),
    );
    expect(first.alreadyStarted).toBe(false);
    const second = await prisma.$transaction((tx) =>
      markOutputStarted(tx, {
        workspaceId: fixture.workspace.id,
        agentId: agent.id,
        target: { runId: run.id },
      }),
    );
    expect(second.alreadyStarted).toBe(true);
    expect(second.outputStartedAt.getTime()).toBe(first.outputStartedAt.getTime());
  });
});

describe("agent-dispatch-inbox — state derivation", () => {
  const now = new Date("2026-05-19T12:00:00Z").getTime();
  const staleMs = 60_000;

  it("derives run dispatchState in order of precedence", () => {
    expect(
      deriveRunDispatchState({
        acknowledgedAt: null,
        outputStartedAt: null,
        lastWakeAt: null,
        lastEventAt: new Date(now - 1000),
        status: "ACTIVE",
        now,
        staleMs,
      }),
    ).toBe("queued");
    expect(
      deriveRunDispatchState({
        acknowledgedAt: null,
        outputStartedAt: null,
        lastWakeAt: new Date(now - 1000),
        lastEventAt: new Date(now - 1000),
        status: "ACTIVE",
        now,
        staleMs,
      }),
    ).toBe("wake-sent");
    expect(
      deriveRunDispatchState({
        acknowledgedAt: new Date(now - 1000),
        outputStartedAt: null,
        lastWakeAt: new Date(now - 1000),
        lastEventAt: new Date(now - 1000),
        status: "ACTIVE",
        now,
        staleMs,
      }),
    ).toBe("acknowledged");
    expect(
      deriveRunDispatchState({
        acknowledgedAt: new Date(now - 1000),
        outputStartedAt: new Date(now - 1000),
        lastWakeAt: new Date(now - 1000),
        lastEventAt: new Date(now - 1000),
        status: "ACTIVE",
        now,
        staleMs,
      }),
    ).toBe("running");
    expect(
      deriveRunDispatchState({
        acknowledgedAt: null,
        outputStartedAt: null,
        lastWakeAt: new Date(now - 120_000),
        lastEventAt: new Date(now - 120_000),
        status: "ACTIVE",
        now,
        staleMs,
      }),
    ).toBe("stalled");
  });

  it("derives chat dispatchState in order of precedence", () => {
    expect(
      deriveChatDispatchState({
        acknowledgedAt: null,
        outputStartedAt: null,
        lastWakeAt: null,
        createdAt: new Date(now - 1000),
        now,
        staleMs,
      }),
    ).toBe("queued");
    expect(
      deriveChatDispatchState({
        acknowledgedAt: null,
        outputStartedAt: null,
        lastWakeAt: new Date(now - 1000),
        createdAt: new Date(now - 1000),
        now,
        staleMs,
      }),
    ).toBe("wake-sent");
    expect(
      deriveChatDispatchState({
        acknowledgedAt: new Date(now - 1000),
        outputStartedAt: null,
        lastWakeAt: new Date(now - 1000),
        createdAt: new Date(now - 1000),
        now,
        staleMs,
      }),
    ).toBe("acknowledged");
    expect(
      deriveChatDispatchState({
        acknowledgedAt: new Date(now - 1000),
        outputStartedAt: new Date(now - 1000),
        lastWakeAt: new Date(now - 1000),
        createdAt: new Date(now - 1000),
        now,
        staleMs,
      }),
    ).toBe("running");
  });
});
