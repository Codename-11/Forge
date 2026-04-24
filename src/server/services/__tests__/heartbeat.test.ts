import { describe, it, expect, afterAll, afterEach } from "vitest";
import { AgentStatus, EventKind } from "@prisma/client";
import { sweepIdleAgents } from "@/server/services/heartbeat";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

/**
 * Integration coverage for the heartbeat-driven auto-offline sweep.
 * Real Postgres, no mocks — mirrors the dispatcher test style.
 *
 * Each test owns its own workspace so they can run in parallel without
 * cross-talk from the tenant-scoped sweep.
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

/**
 * Helper — flip the workspace's idle timeout to `minutes`. The sweep
 * short-circuits on `agentIdleTimeoutMinutes == 0`, which is the default
 * from `createWorkspaceFixture`, so every test has to opt in.
 */
async function setIdleTimeout(
  workspaceId: string,
  minutes: number,
): Promise<void> {
  const prisma = getPrisma();
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { agentIdleTimeoutMinutes: minutes },
  });
}

/** Create an agent with the given status + heartbeat. */
async function createAgent(
  workspaceId: string,
  opts: {
    profileKey: string;
    status?: AgentStatus;
    lastHeartbeatAt?: Date | null;
    archivedAt?: Date | null;
  },
): Promise<{ id: string }> {
  const prisma = getPrisma();
  return prisma.agent.create({
    data: {
      workspaceId,
      name: opts.profileKey,
      profileKey: opts.profileKey,
      status: opts.status ?? AgentStatus.ONLINE,
      lastHeartbeatAt: opts.lastHeartbeatAt ?? null,
      archivedAt: opts.archivedAt ?? null,
    },
    select: { id: true },
  });
}

describe("heartbeat — sweepIdleAgents", () => {
  it("flips an ONLINE agent with a stale heartbeat to OFFLINE", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBA" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setIdleTimeout(fixture.workspace.id, 5);

    const stale = new Date(Date.now() - 30 * 60_000); // 30m ago, >> 5m cutoff
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hba-stale",
      status: AgentStatus.ONLINE,
      lastHeartbeatAt: stale,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.OFFLINE);

    // Audit + event written with the expected EventKind + payload.
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "agent",
        subjectId: agent.id,
        kind: EventKind.AGENT_STATUS_CHANGED,
      },
    });
    expect(events.length).toBe(1);
    const payload = events[0].payload as {
      from: string;
      to: string;
      reason: string;
      timeoutMinutes: number;
    };
    expect(payload.from).toBe(AgentStatus.ONLINE);
    expect(payload.to).toBe(AgentStatus.OFFLINE);
    expect(payload.reason).toBe("heartbeat-timeout");
    expect(payload.timeoutMinutes).toBe(5);

    const audit = await prisma.auditLog.findFirst({
      where: {
        workspaceId: fixture.workspace.id,
        entity: "Agent",
        entityId: agent.id,
        action: "auto-offline",
      },
    });
    expect(audit).not.toBeNull();
  });

  it("leaves a fresh heartbeat alone", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBB" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setIdleTimeout(fixture.workspace.id, 10);

    const fresh = new Date(Date.now() - 60_000); // 1m ago, well inside 10m
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbb-fresh",
      status: AgentStatus.ONLINE,
      lastHeartbeatAt: fresh,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).not.toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.ONLINE);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "agent",
        subjectId: agent.id,
        kind: EventKind.AGENT_STATUS_CHANGED,
      },
    });
    expect(events.length).toBe(0);
  });

  it("leaves an already-OFFLINE agent alone (no duplicate audit)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setIdleTimeout(fixture.workspace.id, 5);

    const stale = new Date(Date.now() - 60 * 60_000); // 1h ago
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbc-offline",
      status: AgentStatus.OFFLINE,
      lastHeartbeatAt: stale,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).not.toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.OFFLINE);

    // No event should have been written — the guarded updateMany filters
    // on status != OFFLINE, so nothing changed, so nothing audited.
    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "agent",
        subjectId: agent.id,
        kind: EventKind.AGENT_STATUS_CHANGED,
      },
    });
    expect(events.length).toBe(0);
  });

  it("respects a very large workspace timeout", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBD" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // 7 days — any heartbeat within the last week is considered fresh.
    await setIdleTimeout(fixture.workspace.id, 7 * 24 * 60);

    const somewhatStale = new Date(Date.now() - 2 * 60 * 60_000); // 2h ago
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbd-slow",
      status: AgentStatus.ONLINE,
      lastHeartbeatAt: somewhatStale,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).not.toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.ONLINE);
  });

  it("skips workspaces with agentIdleTimeoutMinutes == 0", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBE" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    // Do NOT set a timeout — default is 0.
    const stale = new Date(Date.now() - 60 * 60_000);
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbe-disabled",
      status: AgentStatus.ONLINE,
      lastHeartbeatAt: stale,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).not.toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.ONLINE);
  });

  it("flips an agent that has never heartbeated once the workspace opts in", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBF" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setIdleTimeout(fixture.workspace.id, 5);

    // lastHeartbeatAt=null — an agent that registered but never pinged.
    // Treated as stale: `OR: [{ lastHeartbeatAt: null }, ...]`.
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbf-silent",
      status: AgentStatus.ONLINE,
      lastHeartbeatAt: null,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.OFFLINE);
  });

  it("ignores archived agents even if they have a stale heartbeat", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBG" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setIdleTimeout(fixture.workspace.id, 5);

    const stale = new Date(Date.now() - 60 * 60_000);
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbg-archived",
      status: AgentStatus.ONLINE,
      lastHeartbeatAt: stale,
      archivedAt: new Date(),
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).not.toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    // Archived agents are excluded from the sweep; their status is left as-is.
    expect(after.status).toBe(AgentStatus.ONLINE);
  });

  it("flips a BUSY agent with a stale heartbeat (any non-OFFLINE status)", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "HBH" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await setIdleTimeout(fixture.workspace.id, 5);

    const stale = new Date(Date.now() - 30 * 60_000);
    const agent = await createAgent(fixture.workspace.id, {
      profileKey: "hbh-busy",
      status: AgentStatus.BUSY,
      lastHeartbeatAt: stale,
    });

    const res = await sweepIdleAgents();
    expect(res.flipped).toContain(agent.id);

    const after = await prisma.agent.findUniqueOrThrow({
      where: { id: agent.id },
    });
    expect(after.status).toBe(AgentStatus.OFFLINE);

    const events = await prisma.activityEvent.findMany({
      where: {
        workspaceId: fixture.workspace.id,
        subjectType: "agent",
        subjectId: agent.id,
        kind: EventKind.AGENT_STATUS_CHANGED,
      },
    });
    expect(events.length).toBe(1);
    const payload = events[0].payload as { from: string };
    expect(payload.from).toBe(AgentStatus.BUSY);
  });
});
