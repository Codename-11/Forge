import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ApiKeyKind, PluginScope, PluginStatus, UserStatus } from "@prisma/client";
import { assertKeyScope, authenticateApiKey } from "@/server/services/api-key-auth";
import type { ApiKeyError } from "@/server/services/api-key-auth";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";

const fixtures: TestFixture[] = [];
let sequence = 0;

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function createKey(
  fixture: TestFixture,
  input: {
    kind: ApiKeyKind;
    userId?: string | null;
    pluginId?: string | null;
    linkedAgentId?: string | null;
    scopes?: PluginScope[];
  },
) {
  const raw = `forge_sk_auth-test-${Date.now()}-${sequence++}`;
  await getPrisma().apiKey.create({
    data: {
      workspaceId: fixture.workspace.id,
      name: `auth test ${sequence}`,
      hashedKey: createHash("sha256").update(raw).digest("hex"),
      prefix: raw.slice(0, 18),
      kind: input.kind,
      userId: input.userId ?? null,
      pluginId: input.pluginId ?? null,
      linkedAgentId: input.linkedAgentId ?? null,
      scopes: input.scopes ?? [PluginScope.READ_ISSUES],
    },
  });
  return raw;
}

describe("authenticateApiKey user-principal revalidation", () => {
  it("resolves a live PERSONAL key with its current membership role", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUP" });
    fixtures.push(fixture);
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.PERSONAL,
      userId: fixture.user.id,
      scopes: [PluginScope.READ_ISSUES, PluginScope.ADMIN],
    });

    const principal = await authenticateApiKey(raw);
    expect(principal).toMatchObject({
      principalType: "USER",
      kind: ApiKeyKind.PERSONAL,
      userId: fixture.user.id,
      membershipRole: "OWNER",
    });
    expect(principal.scopes).toContain(PluginScope.ADMIN);
  });

  it("strips effective ADMIN after a role demotion", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUD" });
    fixtures.push(fixture);
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.SESSION,
      userId: fixture.secondUser.id,
      scopes: [PluginScope.READ_ISSUES, PluginScope.ADMIN],
    });

    const principal = await authenticateApiKey(raw);
    expect(principal.membershipRole).toBe("MEMBER");
    expect(principal.scopes).toEqual([PluginScope.READ_ISSUES]);
    await expect(authenticateApiKey(raw, [PluginScope.ADMIN])).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<ApiKeyError>);
  });

  it.each([
    [UserStatus.INVITED, null, null],
    [UserStatus.SUSPENDED, new Date(), null],
    [UserStatus.DELETED, new Date(), new Date()],
  ])(
    "rejects a %s user even when the key row remains live",
    async (status, disabledAt, deletedAt) => {
      const fixture = await createWorkspaceFixture({ keyPrefix: "AUS" });
      fixtures.push(fixture);
      const raw = await createKey(fixture, {
        kind: ApiKeyKind.PERSONAL,
        userId: fixture.secondUser.id,
      });
      await getPrisma().user.update({
        where: { id: fixture.secondUser.id },
        data: { status, disabledAt, deletedAt },
      });

      await expect(authenticateApiKey(raw)).rejects.toMatchObject({ status: 403 });
    },
  );

  it("rejects a user key immediately after workspace membership removal", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUM" });
    fixtures.push(fixture);
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.SESSION,
      userId: fixture.secondUser.id,
    });
    await getPrisma().membership.delete({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });

    await expect(authenticateApiKey(raw)).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a malformed user key that is linked to an agent", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUX" });
    fixtures.push(fixture);
    const agent = await getPrisma().agent.create({
      data: { workspaceId: fixture.workspace.id, profileKey: `auth-${sequence}`, name: "Auth" },
    });
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.PERSONAL,
      userId: fixture.user.id,
      linkedAgentId: agent.id,
    });

    await expect(authenticateApiKey(raw)).rejects.toMatchObject({ status: 401 });
  });

  it("revalidates ProjectAccess live while retaining key narrowing as a ceiling", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUG" });
    fixtures.push(fixture);
    const prisma = getPrisma();
    const [allowed, other] = await Promise.all([
      prisma.project.create({
        data: {
          workspaceId: fixture.workspace.id,
          key: `G${sequence++}`,
          name: "Granted",
          visibility: "RESTRICTED",
          createdById: fixture.user.id,
        },
      }),
      prisma.project.create({
        data: {
          workspaceId: fixture.workspace.id,
          key: `H${sequence++}`,
          name: "Other",
          visibility: "RESTRICTED",
          createdById: fixture.user.id,
        },
      }),
    ]);
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.PERSONAL,
      userId: fixture.secondUser.id,
    });
    const principal = await authenticateApiKey(raw);
    const scopeContext = { apiKey: { ...principal, projectIds: [allowed.id] }, db: prisma };

    await expect(
      assertKeyScope(scopeContext, { entity: "project", id: allowed.id }),
    ).rejects.toThrow(/scope/i);
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });
    const grant = await prisma.projectAccess.create({
      data: {
        workspaceId: fixture.workspace.id,
        projectId: allowed.id,
        membershipId: membership.id,
        role: "VIEWER",
        grantedById: fixture.user.id,
      },
    });
    await expect(
      assertKeyScope(scopeContext, { entity: "project", id: allowed.id }),
    ).resolves.toBeUndefined();
    await expect(assertKeyScope(scopeContext, { entity: "project", id: other.id })).rejects.toThrow(
      /scope/i,
    );

    await prisma.projectAccess.delete({ where: { id: grant.id } });
    await expect(
      assertKeyScope(scopeContext, { entity: "project", id: allowed.id }),
    ).rejects.toThrow(/scope/i);
  });
});

describe("authenticateApiKey service principals", () => {
  it("keeps an AGENT key independent from its issuer lifecycle and membership", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUA" });
    fixtures.push(fixture);
    const agent = await getPrisma().agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `service-${sequence}`,
        name: "Service",
      },
    });
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.AGENT,
      userId: fixture.secondUser.id,
      linkedAgentId: agent.id,
      scopes: [PluginScope.ADMIN],
    });
    await getPrisma().user.update({
      where: { id: fixture.secondUser.id },
      data: { status: UserStatus.SUSPENDED, disabledAt: new Date() },
    });
    await getPrisma().membership.delete({
      where: {
        userId_workspaceId: {
          userId: fixture.secondUser.id,
          workspaceId: fixture.workspace.id,
        },
      },
    });

    const principal = await authenticateApiKey(raw, [PluginScope.ADMIN]);
    expect(principal).toMatchObject({
      principalType: "AGENT",
      membershipRole: null,
      linkedAgentId: agent.id,
    });
  });

  it("keeps PLUGIN authorization tied to plugin approval", async () => {
    const fixture = await createWorkspaceFixture({ keyPrefix: "AUL" });
    fixtures.push(fixture);
    const plugin = await getPrisma().plugin.create({
      data: {
        workspaceId: fixture.workspace.id,
        slug: `auth-${sequence}`,
        name: "Auth plugin",
        version: "1.0.0",
        manifest: {},
        scopes: [PluginScope.READ_ISSUES],
        status: PluginStatus.APPROVED,
      },
    });
    const raw = await createKey(fixture, {
      kind: ApiKeyKind.AGENT,
      pluginId: plugin.id,
    });
    expect(await authenticateApiKey(raw)).toMatchObject({ principalType: "PLUGIN" });

    await getPrisma().plugin.update({
      where: { id: plugin.id },
      data: { status: PluginStatus.SUSPENDED },
    });
    await expect(authenticateApiKey(raw)).rejects.toMatchObject({ status: 403 });
  });
});
