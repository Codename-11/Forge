import { afterAll, afterEach, describe, expect, it } from "vitest";
import { IntegrationPrincipalType } from "@prisma/client";
import {
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { ensureMappingAuthorization } from "@/server/services/github/linkability";
import { assertIntegrationAction } from "@/server/services/integration-authorization";

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
  return { db, fixture, mapping };
}

describe("integration grant enforcement", () => {
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
