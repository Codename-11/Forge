import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AgentProvider, PluginScope, RuntimeKind } from "@prisma/client";
import { agentProfileRouter } from "@/server/routers/agent-profile";
import { agentBindingRouter } from "@/server/routers/agent-binding";
import {
  buildContext,
  createWorkspaceFixture,
  createIssue,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "./helpers";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  await getPrisma().agentProfile.deleteMany({
    where: {
      ownerId: { in: fixtures.flatMap((fixture) => [fixture.user.id, fixture.secondUser.id]) },
    },
  });
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

describe("Agent Studio profile ownership", () => {
  it.each(["MEMBER", "GUEST"] as const)(
    "filters restricted-project run content for a %s until explicitly granted",
    async (role) => {
      const fixture = await createWorkspaceFixture({ keyPrefix: "PR" });
      fixtures.push(fixture);
      const prisma = getPrisma();
      const membership = await prisma.membership.update({
        where: {
          userId_workspaceId: { userId: fixture.secondUser.id, workspaceId: fixture.workspace.id },
        },
        data: { role },
      });
      const project = await prisma.project.create({
        data: {
          workspaceId: fixture.workspace.id,
          createdById: fixture.user.id,
          key: "PRIVATE",
          name: "Restricted project",
          visibility: "RESTRICTED",
        },
      });
      const issue = await createIssue(fixture, {
        title: "Restricted issue",
        projectId: project.id,
      });
      const profile = await prisma.agentProfile.create({
        data: {
          ownerId: fixture.secondUser.id,
          profileKey: `restricted-${role.toLowerCase()}`,
          name: "Project agent",
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
      await prisma.agentRun.create({
        data: {
          workspaceId: fixture.workspace.id,
          agentId: binding.id,
          issueId: issue.id,
          currentStep: "Restricted current step",
        },
      });
      const caller = agentProfileRouter.createCaller(
        await buildContext(fixture, { asUserId: fixture.secondUser.id }),
      );
      const hidden = await caller.get({ id: profile.id });
      expect(hidden.bindings).toHaveLength(1);
      expect(hidden.recentRuns).toEqual([]);
      await prisma.projectAccess.create({
        data: {
          workspaceId: fixture.workspace.id,
          projectId: project.id,
          membershipId: membership.id,
          role: "VIEWER",
        },
      });
      const permitted = await caller.get({ id: profile.id });
      expect(permitted.recentRuns).toHaveLength(1);
      expect(permitted.recentRuns[0]?.issue.id).toBe(issue.id);
      await prisma.projectAccess.deleteMany({
        where: { projectId: project.id, membershipId: membership.id },
      });
      expect((await caller.get({ id: profile.id })).recentRuns).toEqual([]);
      await prisma.user.update({
        where: { id: fixture.secondUser.id },
        data: { instanceRole: "INSTANCE_ADMIN" },
      });
      expect((await caller.get({ id: profile.id })).recentRuns).toHaveLength(1);
    },
  );

  it("returns credential presence without exposing dispatch secrets to shared-profile viewers", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "PS" });
    fixtures.push(fixture);
    const profile = await getPrisma().agentProfile.create({
      data: {
        ownerId: fixture.user.id,
        profileKey: "safe-shared-definition",
        name: "Shared definition",
        instanceShared: true,
        webhookSecret: `test-only-${fixture.workspace.id}`,
      },
    });
    const context = await buildContext(fixture, { asUserId: fixture.secondUser.id });
    const profiles = agentProfileRouter.createCaller(context);
    const bindings = agentBindingRouter.createCaller(context);
    const reads = [
      await profiles.get({ id: profile.id }),
      (await profiles.list()).find((row) => row.id === profile.id)!,
      (await bindings.catalog()).find((row) => row.id === profile.id)!,
    ];
    for (const read of reads) {
      expect("webhookSecret" in read).toBe(false);
      expect(read.hasWebhookSecret).toBe(true);
    }
    await getPrisma().agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileId: profile.id,
        profileKey: profile.profileKey,
        name: profile.name,
        webhookSecret: profile.webhookSecret,
      },
    });
    const binding = (await bindings.list())[0]!;
    expect("webhookSecret" in binding).toBe(false);
    expect(binding.hasWebhookSecret).toBe(true);
  });

  it("redacts credentials from setup and governance mutation responses without clearing them", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "PM" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    await prisma.user.update({
      where: { id: fixture.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    const profile = await prisma.agentProfile.create({
      data: {
        ownerId: fixture.secondUser.id,
        profileKey: "shared-secret",
        name: "Shared agent",
        instanceShared: true,
        webhookSecret: `test-only-${fixture.workspace.id}`,
      },
    });
    const context = await buildContext(fixture);
    const profiles = agentProfileRouter.createCaller(context);
    const bindings = agentBindingRouter.createCaller(context);
    const bound = await bindings.bind({ profileId: profile.id });
    const policy = await bindings.setPolicy({ agentId: bound.id, maxConcurrent: 2 });
    const unbound = await bindings.unbind({ agentId: bound.id });
    const rebound = await bindings.bindFromMissionControl({
      workspaceId: fixture.workspace.id,
      profileId: profile.id,
    });
    const unboundAgain = await bindings.unbindFromMissionControl({
      workspaceId: fixture.workspace.id,
      agentId: rebound.id,
    });
    const updated = await profiles.update({ id: profile.id, name: "Updated shared agent" });
    const shared = await profiles.setInstanceShared({ id: profile.id, instanceShared: false });
    const disabled = await profiles.setDisabled({ id: profile.id, disabled: true });
    const approved = await profiles.approve({ id: profile.id });
    const rejected = await profiles.reject({ id: profile.id });
    const archived = await profiles.archive({ id: profile.id });
    for (const response of [
      bound,
      policy,
      unbound,
      rebound,
      unboundAgain,
      updated,
      shared,
      disabled,
      approved,
      rejected,
      archived,
    ]) {
      expect("webhookSecret" in response).toBe(false);
      expect(response.hasWebhookSecret).toBe(true);
    }
    const stored = await prisma.agentProfile.findUniqueOrThrow({
      where: { id: profile.id },
      select: { webhookSecret: true },
    });
    expect(Boolean(stored.webhookSecret)).toBe(true);
  });

  it("does not turn profile ownership into cross-workspace work or key access", async () => {
    const owner = await createWorkspaceFixture({ keyPrefix: "PO" });
    const other = await createWorkspaceFixture({ keyPrefix: "PX" });
    fixtures.push(owner, other);
    const prisma = getPrisma();
    const profile = await prisma.agentProfile.create({
      data: {
        ownerId: owner.user.id,
        profileKey: "isolated-owner",
        name: "Owned agent",
        instanceShared: true,
      },
    });
    const binding = await prisma.agent.create({
      data: {
        workspaceId: other.workspace.id,
        profileId: profile.id,
        profileKey: profile.profileKey,
        name: profile.name,
      },
    });
    await prisma.apiKey.create({
      data: {
        workspaceId: other.workspace.id,
        userId: other.user.id,
        name: "Private client",
        hashedKey: `private-${profile.id}`,
        prefix: "private",
        scopes: [PluginScope.READ_ISSUES],
        linkedAgentId: binding.id,
      },
    });
    const issue = await createIssue(other, { title: "Private workspace issue" });
    await prisma.agentRun.create({
      data: {
        workspaceId: other.workspace.id,
        issueId: issue.id,
        agentId: binding.id,
        currentStep: "Private workspace work",
      },
    });
    const caller = agentProfileRouter.createCaller(await buildContext(owner));
    const detail = await caller.get({ id: profile.id });
    expect(detail.canEdit).toBe(true);
    expect(detail.bindings).toEqual([]);
    expect(detail.bindingCount).toBe(0);
    expect(detail.recentRuns).toEqual([]);
    expect(detail.owner).toEqual({ id: owner.user.id, name: owner.user.name, image: null });
    expect(detail.availability).toEqual({ scope: "INSTANCE_CATALOG", state: "AVAILABLE" });
    const listed = (await caller.list()).find((row) => row.id === profile.id)!;
    expect(listed.bindings).toEqual([]);
    expect(listed.bindingCount).toBe(0);
    expect(listed.clientCount).toBe(0);

    // Explicit instance administration retains the existing global visibility.
    await prisma.user.update({
      where: { id: owner.user.id },
      data: { instanceRole: "INSTANCE_ADMIN" },
    });
    const adminDetail = await caller.get({ id: profile.id });
    expect(adminDetail.bindings).toHaveLength(1);
    expect(adminDetail.bindings[0]?.apiKeys[0]?.name).toBe("Private client");
    expect(adminDetail.bindings[0]?.canManage).toBe(false);
    expect(adminDetail.recentRuns).toHaveLength(1);
  });

  it("syncs identity execution fields to active workspace bindings", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "APS" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const runtime = await prisma.runtime.create({
      data: {
        workspaceId: fixture.workspace.id,
        ownerId: fixture.user.id,
        ownerType: "PERSONAL",
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
