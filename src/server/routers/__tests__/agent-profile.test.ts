import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentProvider, PluginScope, RuntimeKind } from "@prisma/client";
import { agentProfileRouter } from "@/server/routers/agent-profile";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("Agent Studio profile ownership", () => {
  it("syncs identity execution fields to active workspace bindings", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "APS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerId: fixture.user.id,
        name: "Codex primary",
        kind: RuntimeKind.REMOTE_HTTP,
      },
    });
    const profile = await prisma.agentProfile.create({
      data: {
        ownerId: fixture.user.id,
        profileKey: "studio-sync",
        name: "Studio Sync",
      },
    });
    const binding = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileId: profile.id,
        profileKey: profile.profileKey,
        name: profile.name,
      },
    });

    const caller = agentProfileRouter.createCaller(await buildContext(fixture));
    await caller.update({
      id: profile.id,
      name: "Studio Sync Updated",
      provider: AgentProvider.CODEX,
      runtimeId: runtime.id,
    });

    await expect(
      prisma.agent.findUniqueOrThrow({
        where: { id: binding.id },
        select: { name: true, provider: true, runtimeId: true },
      }),
    ).resolves.toEqual({
      name: "Studio Sync Updated",
      provider: AgentProvider.CODEX,
      runtimeId: runtime.id,
    });
  });

  it("returns every MCP client attached across profile bindings", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "APC" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const profile = await prisma.agentProfile.create({
      data: {
        ownerId: fixture.user.id,
        profileKey: "multi-client",
        name: "Multi Client",
      },
    });
    const binding = await prisma.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileId: profile.id,
        profileKey: profile.profileKey,
        name: profile.name,
      },
    });
    await prisma.apiKey.createMany({
      data: [
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          name: "Codex desktop",
          hashedKey: `hash-${profile.id}-codex`,
          prefix: "forge_sk_codex",
          scopes: [PluginScope.READ_ISSUES],
          linkedAgentId: binding.id,
        },
        {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          name: "Codex CLI",
          hashedKey: `hash-${profile.id}-cli`,
          prefix: "forge_sk_cli",
          scopes: [PluginScope.READ_ISSUES, PluginScope.WRITE_ISSUES],
          linkedAgentId: binding.id,
        },
      ],
    });

    const caller = agentProfileRouter.createCaller(await buildContext(fixture));
    const result = await caller.get({ id: profile.id });

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.apiKeys.map((key) => key.name)).toEqual(
      expect.arrayContaining(["Codex CLI", "Codex desktop"]),
    );
  });
});
