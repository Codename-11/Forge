import { describe, it, expect, afterEach, afterAll } from "vitest";
import { AgentRuntimeMode, AgentStatus } from "@prisma/client";
import { sweepIdleEphemeralAgents } from "@/server/services/ephemeral-idle";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function makeAgent(
  fixture: TestFixture,
  opts: {
    key: string;
    mode: AgentRuntimeMode;
    status: AgentStatus;
    createdAt: Date;
    lastHeartbeatAt: Date | null;
  },
) {
  return getPrisma().agent.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: opts.key,
      profileKey: opts.key,
      runtimeMode: opts.mode,
      status: opts.status,
      createdAt: opts.createdAt,
      lastHeartbeatAt: opts.lastHeartbeatAt,
    },
    select: { id: true },
  });
}

describe("sweepIdleEphemeralAgents", () => {
  it("archives idle EPHEMERAL agents; leaves persistent, busy, recent, and fresh ones", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "EI" });
    fixtures.push(fixture);
    await getPrisma().workspace.update({
      where: { id: fixture.workspace.id },
      data: { ephemeralAgentIdleMinutes: 60 },
    });

    const now = new Date();
    const old = new Date(now.getTime() - 3 * 60 * 60_000); // 3h ago
    const recent = new Date(now.getTime() - 5 * 60_000); // 5m ago

    const idleEphemeral = await makeAgent(fixture, {
      key: "idle-eph",
      mode: AgentRuntimeMode.EPHEMERAL,
      status: AgentStatus.OFFLINE,
      createdAt: old,
      lastHeartbeatAt: old,
    });
    const recentEphemeral = await makeAgent(fixture, {
      key: "recent-eph",
      mode: AgentRuntimeMode.EPHEMERAL,
      status: AgentStatus.ONLINE,
      createdAt: old,
      lastHeartbeatAt: recent,
    });
    const busyEphemeral = await makeAgent(fixture, {
      key: "busy-eph",
      mode: AgentRuntimeMode.EPHEMERAL,
      status: AgentStatus.BUSY,
      createdAt: old,
      lastHeartbeatAt: old,
    });
    const idlePersistent = await makeAgent(fixture, {
      key: "idle-pers",
      mode: AgentRuntimeMode.PERSISTENT,
      status: AgentStatus.OFFLINE,
      createdAt: old,
      lastHeartbeatAt: old,
    });
    const freshEphemeral = await makeAgent(fixture, {
      key: "fresh-eph",
      mode: AgentRuntimeMode.EPHEMERAL,
      status: AgentStatus.OFFLINE,
      createdAt: recent,
      lastHeartbeatAt: null,
    });

    const res = await sweepIdleEphemeralAgents(now);

    expect(res.archived).toContain(idleEphemeral.id);
    expect(res.archived).not.toContain(recentEphemeral.id);
    expect(res.archived).not.toContain(busyEphemeral.id);
    expect(res.archived).not.toContain(idlePersistent.id);
    expect(res.archived).not.toContain(freshEphemeral.id);

    const prisma = getPrisma();
    const idleRow = await prisma.agent.findUnique({
      where: { id: idleEphemeral.id },
      select: { archivedAt: true, status: true },
    });
    expect(idleRow?.archivedAt).not.toBeNull();
    expect(idleRow?.status).toBe("OFFLINE");
    const recentRow = await prisma.agent.findUnique({
      where: { id: recentEphemeral.id },
      select: { archivedAt: true },
    });
    expect(recentRow?.archivedAt).toBeNull();
  });
});
