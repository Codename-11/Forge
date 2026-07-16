import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AgentConnectionCapability,
  AgentConnectionKind,
  AgentConnectionLiveness,
  AgentConnectionStatus,
  AgentStatus,
  LivenessConfidence,
} from "@prisma/client";
import {
  sanitizeAgentConnectionMetadata,
  revokeAgentConnectionsForApiKey,
  touchAgentConnection,
  upsertAgentConnection,
} from "@/server/services/agent-connection";
import {
  createIssue,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import {
  handoffWorkSession,
  joinWorkSession,
} from "@/server/services/work-session-participant";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => disconnectPrisma());

describe("agent connection provenance", () => {
  it("redacts credential-shaped metadata and bounds protocol values", () => {
    expect(
      sanitizeAgentConnectionMetadata({
        client: { name: "Codex Desktop", version: "1.2.3" },
        authorization: "Bearer secret",
        accessToken: "secret",
        note: "x".repeat(700),
      }),
    ).toEqual({
      client: { name: "Codex Desktop", version: "1.2.3" },
      note: "x".repeat(512),
    });
  });

  it("idempotently registers a stable MCP instance and refreshes liveness", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const agent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Codex",
        profileKey: `codex-${fixture.workspace.id}`,
        status: AgentStatus.OFFLINE,
      },
    });
    const apiKey = await prisma.apiKey.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        name: "Codex MCP test key",
        hashedKey: `agent-connection-${fixture.workspace.id}`,
        prefix: "forge_ac_test",
        scopes: [],
        linkedAgentId: agent.id,
      },
    });

    const input = {
      workspaceId: fixture.workspace.id,
      agentId: agent.id,
      kind: AgentConnectionKind.MCP_CLIENT,
      livenessModel: AgentConnectionLiveness.LEASE,
      apiKeyId: apiKey.id,
      instanceKey: "mcp-session-123",
      displayName: "Codex Desktop",
      clientName: "codex-desktop",
      clientVersion: "1.2.3",
      capabilities: [AgentConnectionCapability.TOOL_ACTIVITY],
      metadata: { protocolVersion: "2025-03-26", apiToken: "do-not-store" },
    };

    const first = await upsertAgentConnection(prisma, input);
    const second = await upsertAgentConnection(prisma, input);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      status: AgentConnectionStatus.ACTIVE,
      confidence: LivenessConfidence.CONFIRMED,
      metadata: { protocolVersion: "2025-03-26" },
    });

    const seenAt = new Date("2026-07-16T12:00:00.000Z");
    const touched = await touchAgentConnection(prisma, first.id, {
      seenAt,
      confidence: LivenessConfidence.INFERRED,
    });
    expect(touched.lastSeenAt).toEqual(seenAt);
    expect(touched.confidence).toBe(LivenessConfidence.INFERRED);

    expect(await revokeAgentConnectionsForApiKey(prisma, apiKey.id, seenAt)).toBe(1);
    const revoked = await prisma.agentConnection.findUniqueOrThrow({ where: { id: first.id } });
    expect(revoked).toMatchObject({
      status: AgentConnectionStatus.REVOKED,
      confidence: LivenessConfidence.CONFIRMED,
      revokedAt: seenAt,
      disconnectedAt: seenAt,
    });
  });

  it("joins non-primary participants and atomically hands off primary ownership", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AH" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const issue = await createIssue(fixture, { statusCategory: "IN_PROGRESS" });
    const firstAgent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Codex",
        profileKey: `codex-${fixture.workspace.id}`,
      },
    });
    const secondAgent = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Victor",
        profileKey: `victor-${fixture.workspace.id}`,
      },
    });
    const first = await upsertAgentConnection(prisma, {
      workspaceId: fixture.workspace.id,
      agentId: firstAgent.id,
      kind: AgentConnectionKind.MCP_CLIENT,
      livenessModel: AgentConnectionLiveness.LEASE,
      instanceKey: "mcp-primary",
    });
    const second = await upsertAgentConnection(prisma, {
      workspaceId: fixture.workspace.id,
      agentId: secondAgent.id,
      kind: AgentConnectionKind.MANAGED_RUNTIME,
      livenessModel: AgentConnectionLiveness.HEARTBEAT,
      instanceKey: "runtime-reviewer",
    });
    const session = await prisma.workSession.create({
      data: {
        workspaceId: fixture.workspace.id,
        issueId: issue.id,
        ownerAgentId: firstAgent.id,
        ownerConnectionId: first.id,
        source: "CODEX_DESKTOP",
        repoFullName: "acme/forge",
        branch: "codex/connection-handoff",
        participants: {
          create: {
            workspaceId: fixture.workspace.id,
            connectionId: first.id,
            agentId: firstAgent.id,
            role: "PRIMARY",
          },
        },
      },
    });

    await joinWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      connectionId: second.id,
      role: "REVIEWER",
      actor: { userId: fixture.user.id },
    });
    const handedOff = await handoffWorkSession(prisma, {
      workspaceId: fixture.workspace.id,
      sessionId: session.id,
      toConnectionId: second.id,
      actor: { userId: fixture.user.id },
      reason: "Operator reconciled observed execution ownership.",
    });
    expect(handedOff).toMatchObject({
      ownerAgentId: secondAgent.id,
      ownerConnectionId: second.id,
    });
    const activePrimary = await prisma.workSessionParticipant.findMany({
      where: { workSessionId: session.id, role: "PRIMARY", leftAt: null },
    });
    expect(activePrimary).toHaveLength(1);
    expect(activePrimary[0]?.connectionId).toBe(second.id);
  });
});
