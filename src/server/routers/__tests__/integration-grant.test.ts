import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ApiKeyKind,
  IntegrationCapability,
  IntegrationCredentialSource,
  IntegrationGrantScope,
  IntegrationPrincipalType,
  PluginScope,
} from "@prisma/client";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { ensureMappingAuthorization } from "@/server/services/github/linkability";
import { assertIntegrationAction } from "@/server/services/integration-authorization";
import { integrationGrantRouter } from "@/server/routers/integration-grant";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  while (fixtures.length) await fixtures.pop()!.cleanup();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setup() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "IG" });
  fixtures.push(fixture);
  const db = getPrisma();
  const connection = await db.connection.create({
    data: {
      ownerId: fixture.user.id,
      provider: "GITHUB",
      label: "Grant test",
      status: "CONNECTED",
      config: { installationId: "181" },
    },
  });
  const mapping = await db.connectionMapping.create({
    data: {
      workspaceId: fixture.workspace.id,
      connectionId: connection.id,
      kind: "repo",
      target: "acme/private",
      direction: "inbound+outbound",
    },
  });
  await ensureMappingAuthorization({
    db,
    workspaceId: fixture.workspace.id,
    mappingId: mapping.id,
    userId: fixture.user.id,
  });
  return { db, fixture, mapping, connection };
}

describe("integration grant enforcement", () => {
  it("keeps project, initiative, and label key narrowing as an integration ceiling", async () => {
    const { db, fixture, mapping } = await setup();
    const authorization = await db.connectionAuthorization.findUniqueOrThrow({
      where: { connectionMappingId: mapping.id },
    });
    const initiative = await db.initiative.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Scoped initiative",
        slug: `scoped-${Date.now()}`,
        createdById: fixture.user.id,
      },
    });
    const [allowedProject, initiativeProject, otherProject, allowedLabel] = await Promise.all([
      db.project.create({
        data: {
          workspaceId: fixture.workspace.id,
          key: "APROJ",
          name: "Explicit project",
          createdById: fixture.user.id,
        },
      }),
      db.project.create({
        data: {
          workspaceId: fixture.workspace.id,
          key: "IPROJ",
          name: "Initiative project",
          initiativeId: initiative.id,
          createdById: fixture.user.id,
        },
      }),
      db.project.create({
        data: {
          workspaceId: fixture.workspace.id,
          key: "OTHER",
          name: "Other project",
          createdById: fixture.user.id,
        },
      }),
      db.label.create({
        data: { workspaceId: fixture.workspace.id, name: "integration-lane", color: "#123456" },
      }),
    ]);
    const keys = await Promise.all([
      db.apiKey.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          name: "project narrowed",
          hashedKey: `hash-project-${Date.now()}`,
          prefix: "project",
          kind: ApiKeyKind.AGENT,
          scopes: [PluginScope.READ_ISSUES, PluginScope.WRITE_ISSUES],
          projectIds: [allowedProject.id],
        },
      }),
      db.apiKey.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          name: "initiative narrowed",
          hashedKey: `hash-initiative-${Date.now()}`,
          prefix: "initiative",
          kind: ApiKeyKind.AGENT,
          scopes: [PluginScope.READ_ISSUES, PluginScope.WRITE_ISSUES],
          initiativeIds: [initiative.id],
        },
      }),
      db.apiKey.create({
        data: {
          workspaceId: fixture.workspace.id,
          userId: fixture.user.id,
          name: "label narrowed",
          hashedKey: `hash-label-${Date.now()}`,
          prefix: "label",
          kind: ApiKeyKind.AGENT,
          scopes: [PluginScope.READ_ISSUES, PluginScope.WRITE_ISSUES],
          labelIds: [allowedLabel.id],
        },
      }),
    ]);
    await db.integrationGrant.createMany({
      data: keys.map((key) => ({
        workspaceId: fixture.workspace.id,
        connectionAuthorizationId: authorization.id,
        principalType: IntegrationPrincipalType.API_KEY,
        principalApiKeyId: key.id,
        scope: IntegrationGrantScope.WORKSPACE,
        capabilities: [
          IntegrationCapability.READ,
          IntegrationCapability.IMPORT,
          IntegrationCapability.LINK,
        ],
        grantedById: fixture.user.id,
      })),
    });

    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "API_KEY", apiKeyId: keys[0]!.id },
        action: "READ",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "API_KEY", apiKeyId: keys[0]!.id },
        action: "IMPORT",
        projectId: allowedProject.id,
      }),
    ).resolves.toMatchObject({ projectId: allowedProject.id });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "API_KEY", apiKeyId: keys[0]!.id },
        action: "IMPORT",
        projectId: otherProject.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "API_KEY", apiKeyId: keys[1]!.id },
        action: "IMPORT",
        projectId: initiativeProject.id,
      }),
    ).resolves.toMatchObject({ projectId: initiativeProject.id });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "API_KEY", apiKeyId: keys[2]!.id },
        action: "IMPORT",
        labelIds: [allowedLabel.id],
      }),
    ).resolves.toMatchObject({ projectId: null });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "API_KEY", apiKeyId: keys[2]!.id },
        action: "IMPORT",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns safe principal and project labels in the admin inventory", async () => {
    const { db, fixture, mapping } = await setup();
    const authorization = await db.connectionAuthorization.findUniqueOrThrow({
      where: { connectionMappingId: mapping.id },
    });
    const project = await db.project.create({
      data: {
        workspaceId: fixture.workspace.id,
        key: "PRIVATE",
        name: "Private launch",
        createdById: fixture.user.id,
        visibility: "RESTRICTED",
      },
    });
    await db.integrationGrant.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionAuthorizationId: authorization.id,
        principalType: IntegrationPrincipalType.USER,
        principalUserId: fixture.secondUser.id,
        scope: IntegrationGrantScope.PROJECT,
        projectId: project.id,
        capabilities: [IntegrationCapability.READ],
        grantedById: fixture.user.id,
      },
    });

    const caller = integrationGrantRouter.createCaller(await buildContext(fixture));
    const rows = await caller.list();
    const row = rows.find((candidate) => candidate.id === authorization.id);
    expect(row?.connectionMapping.connection.owner).toMatchObject({
      id: fixture.user.id,
      email: fixture.user.email,
    });
    expect(row?.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalUser: expect.objectContaining({
            id: fixture.secondUser.id,
            email: fixture.secondUser.email,
          }),
          project: expect.objectContaining({
            id: project.id,
            key: project.key,
            name: project.name,
            visibility: "RESTRICTED",
          }),
        }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toMatch(/hashedKey|tokenEnc|privateKeyEnc/);
  });

  it("lets a member inspect only authorizations for credentials they own", async () => {
    const { db, fixture, mapping } = await setup();
    const secondConnection = await db.connection.create({
      data: {
        ownerId: fixture.secondUser.id,
        provider: "GITHUB",
        label: "Member credential",
        status: "CONNECTED",
        config: { installationId: "182" },
      },
    });
    const secondMapping = await db.connectionMapping.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionId: secondConnection.id,
        kind: "repo",
        target: "acme/member-private",
      },
    });
    await ensureMappingAuthorization({
      db,
      workspaceId: fixture.workspace.id,
      mappingId: secondMapping.id,
      userId: fixture.secondUser.id,
    });

    const memberCaller = integrationGrantRouter.createCaller(
      await buildContext(fixture, { asUserId: fixture.secondUser.id }),
    );
    const owned = await memberCaller.listOwned();
    expect(owned.map((row) => row.connectionMappingId)).toEqual([secondMapping.id]);
    expect(owned[0]?.connectionMapping.connection.ownerId).toBe(fixture.secondUser.id);
    await expect(memberCaller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ownerCaller = integrationGrantRouter.createCaller(await buildContext(fixture));
    const ownerRows = await ownerCaller.listOwned();
    expect(ownerRows.map((row) => row.connectionMappingId)).toEqual([mapping.id]);
  });

  it("requires owner authorization and an exact principal grant even for an owner", async () => {
    const { db, fixture, mapping } = await setup();
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "USER", userId: fixture.user.id },
        action: "LINK",
      }),
    ).resolves.toMatchObject({ mappingId: mapping.id });

    await db.integrationGrant.updateMany({
      where: {
        principalType: IntegrationPrincipalType.USER,
        principalUserId: fixture.user.id,
      },
      data: { revokedAt: new Date(), revokedById: fixture.user.id },
    });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "USER", userId: fixture.user.id },
        action: "READ",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires a separate automation principal grant", async () => {
    const { db, fixture, mapping } = await setup();
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "WORKSPACE_AUTOMATION" },
        action: "SYNC",
      }),
    ).resolves.toMatchObject({ mappingId: mapping.id });

    await db.integrationGrant.updateMany({
      where: {
        principalType: IntegrationPrincipalType.WORKSPACE_AUTOMATION,
        connectionAuthorization: { connectionMappingId: mapping.id },
      },
      data: { revokedAt: new Date(), revokedById: fixture.user.id },
    });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "WORKSPACE_AUTOMATION" },
        action: "SYNC",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("invalidates consent when security-relevant mapping policy changes", async () => {
    const { db, fixture, mapping } = await setup();
    await db.connectionMapping.update({
      where: { id: mapping.id },
      data: { target: "acme/other-private" },
    });
    await expect(
      assertIntegrationAction({
        db,
        workspaceId: fixture.workspace.id,
        mappingId: mapping.id,
        principal: { type: "USER", userId: fixture.user.id },
        action: "READ",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revokes derived grants across both credential-source switches", async () => {
    const { db, fixture, mapping } = await setup();
    const caller = integrationGrantRouter.createCaller(await buildContext(fixture));
    const app = await db.githubApp.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Exact workspace app",
        appId: "181",
        installationId: "181",
        privateKeyEnc: "test-only-encrypted-key",
      },
    });
    const fullCapabilities = Object.values(IntegrationCapability);

    const workspaceAuthorization = await caller.authorize({
      mappingId: mapping.id,
      credentialSource: IntegrationCredentialSource.WORKSPACE_GITHUB_APP,
      githubAppId: app.id,
      capabilities: fullCapabilities,
    });
    expect(
      await db.integrationGrant.count({
        where: { connectionAuthorizationId: workspaceAuthorization.id, revokedAt: null },
      }),
    ).toBe(0);

    await db.integrationGrant.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionAuthorizationId: workspaceAuthorization.id,
        principalType: IntegrationPrincipalType.USER,
        principalUserId: fixture.user.id,
        scope: IntegrationGrantScope.WORKSPACE,
        capabilities: [IntegrationCapability.READ],
        grantedById: fixture.user.id,
      },
    });
    const personalAuthorization = await caller.authorize({
      mappingId: mapping.id,
      credentialSource: IntegrationCredentialSource.USER_CONNECTION,
      githubAppId: null,
      capabilities: fullCapabilities,
    });
    expect(
      await db.integrationGrant.count({
        where: { connectionAuthorizationId: personalAuthorization.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it("revokes derived grants when the credential capability ceiling shrinks", async () => {
    const { db, fixture, mapping } = await setup();
    const caller = integrationGrantRouter.createCaller(await buildContext(fixture));
    const before = await db.connectionAuthorization.findUniqueOrThrow({
      where: { connectionMappingId: mapping.id },
    });
    expect(
      await db.integrationGrant.count({
        where: { connectionAuthorizationId: before.id, revokedAt: null },
      }),
    ).toBeGreaterThan(0);

    const after = await caller.authorize({
      mappingId: mapping.id,
      credentialSource: IntegrationCredentialSource.USER_CONNECTION,
      githubAppId: null,
      capabilities: [IntegrationCapability.READ],
    });
    expect(
      await db.integrationGrant.count({
        where: { connectionAuthorizationId: after.id, revokedAt: null },
      }),
    ).toBe(0);
  });
});
