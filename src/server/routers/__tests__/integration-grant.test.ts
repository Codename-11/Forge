import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  IntegrationCapability,
  IntegrationGrantScope,
  IntegrationPrincipalType,
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
});
