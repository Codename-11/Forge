import {
  ConnectionProvider,
  ConnectionStatus,
  IntegrationCapability,
  IntegrationCredentialSource,
  IntegrationGrantScope,
  IntegrationPrincipalType,
  InstanceRole,
  PluginScope,
  Role,
  UserActionTokenType,
  UserStatus,
} from "@prisma/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { instanceAdminRouter } from "@/server/routers/instance-admin";
import {
  buildContext,
  createWorkspaceFixture,
  disconnectPrisma,
  getPrisma,
  type TestFixture,
} from "@/server/routers/__tests__/helpers";
import { inspectUserActionToken } from "@/server/services/auth-tokens";
import { verifyPassword } from "@/server/services/local-credentials";
import {
  completeAccountSetup,
  createInvitedUser,
  issueUserActionToken,
  reactivateUser,
  softDeleteUser,
  suspendUser,
} from "@/server/services/user-lifecycle";

const fixtures: TestFixture[] = [];
const extraUserIds: string[] = [];

afterEach(async () => {
  const db = getPrisma();
  while (fixtures.length) await fixtures.pop()!.cleanup();
  if (extraUserIds.length) {
    await db.user.deleteMany({ where: { id: { in: extraUserIds.splice(0) } } }).catch(() => {});
  }
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await disconnectPrisma();
});

async function setupAdmin() {
  const fixture = await createWorkspaceFixture({ keyPrefix: "UL" });
  fixtures.push(fixture);
  await getPrisma().user.update({
    where: { id: fixture.user.id },
    data: { instanceRole: InstanceRole.INSTANCE_ADMIN },
  });
  return fixture;
}

describe("user lifecycle", () => {
  it("creates an invited principal and consumes a domain-separated setup token once", async () => {
    const fixture = await setupAdmin();
    const db = getPrisma();
    const email = `invited-${Date.now()}@example.com`;
    const invited = await createInvitedUser(db, {
      actorId: fixture.user.id,
      email,
      name: "Invited User",
    });
    extraUserIds.push(invited.user.id);

    await expect(
      inspectUserActionToken({
        rawToken: invited.setupToken,
        type: UserActionTokenType.ACCOUNT_SETUP,
      }),
    ).resolves.toMatchObject({ state: "VALID" });
    const stored = await db.userActionToken.findFirstOrThrow({
      where: { userId: invited.user.id, type: UserActionTokenType.ACCOUNT_SETUP },
    });
    expect(stored.tokenHash).not.toBe(invited.setupToken);

    const completed = await completeAccountSetup(db, {
      token: invited.setupToken,
      password: "correct horse battery staple",
      name: "Activated User",
    });
    expect(completed.authVersion).toBe(1);

    const user = await db.user.findUniqueOrThrow({
      where: { id: invited.user.id },
      include: { localCredential: true },
    });
    expect(user).toMatchObject({
      status: UserStatus.ACTIVE,
      name: "Activated User",
      authVersion: 1,
    });
    expect(user.emailVerified).toBeTruthy();
    expect(user.localCredential).toBeTruthy();
    await expect(
      verifyPassword("correct horse battery staple", user.localCredential!.passwordHash),
    ).resolves.toBe(true);
    await expect(
      completeAccountSetup(db, {
        token: invited.setupToken,
        password: "another correct horse password",
        name: "Replay",
      }),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("rotates outstanding action tokens of the same purpose", async () => {
    const fixture = await setupAdmin();
    const db = getPrisma();
    const invited = await createInvitedUser(db, {
      actorId: fixture.user.id,
      email: `rotate-${Date.now()}@example.com`,
    });
    extraUserIds.push(invited.user.id);
    const next = await issueUserActionToken(db, {
      actorId: fixture.user.id,
      userId: invited.user.id,
      type: UserActionTokenType.ACCOUNT_SETUP,
    });

    await expect(
      inspectUserActionToken({
        rawToken: invited.setupToken,
        type: UserActionTokenType.ACCOUNT_SETUP,
      }),
    ).resolves.toMatchObject({ state: "USED" });
    await expect(
      inspectUserActionToken({ rawToken: next.token, type: UserActionTokenType.ACCOUNT_SETUP }),
    ).resolves.toMatchObject({ state: "VALID" });
  });

  it("blocks suspension of the last active instance admin and last workspace owner", async () => {
    const fixture = await setupAdmin();
    const db = getPrisma();

    await expect(
      suspendUser(db, { actorId: fixture.user.id, userId: fixture.user.id }),
    ).rejects.toThrow(/last active instance admin/i);

    await db.user.update({
      where: { id: fixture.secondUser.id },
      data: { instanceRole: InstanceRole.INSTANCE_ADMIN },
    });
    await expect(
      suspendUser(db, { actorId: fixture.secondUser.id, userId: fixture.user.id }),
    ).rejects.toThrow(/transfer ownership/i);
  });

  it("suspends access atomically and reactivation does not restore revoked credentials", async () => {
    const fixture = await setupAdmin();
    const db = getPrisma();
    await db.user.update({
      where: { id: fixture.secondUser.id },
      data: { instanceRole: InstanceRole.INSTANCE_ADMIN },
    });
    await db.membership.update({
      where: {
        userId_workspaceId: { userId: fixture.secondUser.id, workspaceId: fixture.workspace.id },
      },
      data: { role: Role.OWNER },
    });
    await db.session.create({
      data: {
        userId: fixture.user.id,
        sessionToken: `session-${Date.now()}`,
        expires: new Date(Date.now() + 86_400_000),
      },
    });
    const key = await db.apiKey.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        name: "Lifecycle test",
        hashedKey: `hash-${Date.now()}`,
        prefix: "frg_test",
        kind: "PERSONAL",
        scopes: [PluginScope.READ_ISSUES],
      },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: fixture.workspace.id,
        profileKey: `lifecycle-service-${Date.now()}`,
        name: "Lifecycle service",
      },
    });
    const serviceKey = await db.apiKey.create({
      data: {
        workspaceId: fixture.workspace.id,
        userId: fixture.user.id,
        linkedAgentId: agent.id,
        name: "Lifecycle service key",
        hashedKey: `service-hash-${Date.now()}`,
        prefix: "frg_service",
        kind: "AGENT",
        scopes: [PluginScope.READ_ISSUES],
      },
    });
    const connection = await db.connection.create({
      data: {
        ownerId: fixture.user.id,
        provider: ConnectionProvider.GITHUB,
        label: "Lifecycle GitHub",
        status: ConnectionStatus.CONNECTED,
        tokenEnc: "encrypted-test-token",
        mappings: {
          create: {
            workspaceId: fixture.workspace.id,
            kind: "repo",
            target: "example/repo",
          },
        },
      },
      include: { mappings: true },
    });
    const personalAuthorization = await db.connectionAuthorization.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionMappingId: connection.mappings[0]!.id,
        credentialSource: IntegrationCredentialSource.USER_CONNECTION,
        capabilities: [IntegrationCapability.READ],
        authorizedById: fixture.user.id,
        authorizationDigest: "personal-lifecycle",
      },
    });
    const personalGrant = await db.integrationGrant.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionAuthorizationId: personalAuthorization.id,
        principalType: IntegrationPrincipalType.USER,
        principalUserId: fixture.user.id,
        scope: IntegrationGrantScope.WORKSPACE,
        capabilities: [IntegrationCapability.READ],
        grantedById: fixture.user.id,
      },
    });
    const app = await db.githubApp.create({
      data: {
        workspaceId: fixture.workspace.id,
        name: "Lifecycle app",
        appId: "12345",
        installationId: "67890",
        privateKeyEnc: "encrypted-private-key",
      },
    });
    const appConnection = await db.connection.create({
      data: {
        ownerId: fixture.user.id,
        provider: ConnectionProvider.GITHUB,
        label: "Workspace GitHub App",
        status: ConnectionStatus.CONNECTED,
        tokenEnc: "app-token-must-survive",
        config: { installationId: "67890" },
        mappings: {
          create: {
            workspaceId: fixture.workspace.id,
            kind: "repo",
            target: "example/app-repo",
          },
        },
      },
      include: { mappings: true },
    });
    const appAuthorization = await db.connectionAuthorization.create({
      data: {
        workspaceId: fixture.workspace.id,
        connectionMappingId: appConnection.mappings[0]!.id,
        credentialSource: IntegrationCredentialSource.WORKSPACE_GITHUB_APP,
        githubAppId: app.id,
        capabilities: [IntegrationCapability.READ],
        authorizedById: fixture.user.id,
        authorizationDigest: "workspace-app-lifecycle",
      },
    });

    const suspended = await suspendUser(db, {
      actorId: fixture.secondUser.id,
      userId: fixture.user.id,
      reason: "Security review",
    });
    expect(suspended.status).toBe(UserStatus.SUSPENDED);
    expect(suspended.revoked).toMatchObject({
      sessions: 1,
      apiKeys: 1,
      connections: 1,
      mappings: 1,
      connectionAuthorizations: 1,
      integrationGrants: 1,
    });
    await expect(db.session.count({ where: { userId: fixture.user.id } })).resolves.toBe(0);
    await expect(db.apiKey.findUniqueOrThrow({ where: { id: key.id } })).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    });
    await expect(
      db.apiKey.findUniqueOrThrow({ where: { id: serviceKey.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      db.connection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      status: ConnectionStatus.DISCONNECTED,
      tokenEnc: null,
    });
    await expect(
      db.connectionMapping.findUniqueOrThrow({ where: { id: connection.mappings[0]!.id } }),
    ).resolves.toMatchObject({ status: "paused" });
    await expect(
      db.connectionAuthorization.findUniqueOrThrow({ where: { id: personalAuthorization.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(
      db.integrationGrant.findUniqueOrThrow({ where: { id: personalGrant.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(
      db.connection.findUniqueOrThrow({ where: { id: appConnection.id } }),
    ).resolves.toMatchObject({
      status: ConnectionStatus.CONNECTED,
      tokenEnc: "app-token-must-survive",
    });
    await expect(
      db.connectionMapping.findUniqueOrThrow({ where: { id: appConnection.mappings[0]!.id } }),
    ).resolves.toMatchObject({ status: "active" });
    await expect(
      db.connectionAuthorization.findUniqueOrThrow({ where: { id: appAuthorization.id } }),
    ).resolves.toMatchObject({ revokedAt: null });

    const active = await reactivateUser(db, {
      actorId: fixture.secondUser.id,
      userId: fixture.user.id,
    });
    expect(active).toMatchObject({ status: UserStatus.ACTIVE, disabledAt: null, authVersion: 2 });
    await expect(db.apiKey.findUniqueOrThrow({ where: { id: key.id } })).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    });
  });

  it("soft deletes to a tombstone while preserving the user row and audit target", async () => {
    const fixture = await setupAdmin();
    const db = getPrisma();
    await db.localCredential.create({
      data: { userId: fixture.secondUser.id, passwordHash: "test-hash" },
    });
    await db.account.create({
      data: {
        userId: fixture.secondUser.id,
        type: "oidc",
        provider: "test-provider",
        providerAccountId: `subject-${Date.now()}`,
      },
    });

    const deleted = await softDeleteUser(db, {
      actorId: fixture.user.id,
      userId: fixture.secondUser.id,
      reason: "Requested deletion",
    });
    expect(deleted.status).toBe(UserStatus.DELETED);
    expect(deleted.avatarCleanup).toEqual({ ok: true, removed: false });
    const tombstone = await db.user.findUniqueOrThrow({ where: { id: fixture.secondUser.id } });
    expect(tombstone.email).toBe(`deleted+${fixture.secondUser.id}@invalid.local`);
    expect(tombstone).toMatchObject({
      name: "Deleted user",
      handle: null,
      image: null,
      status: UserStatus.DELETED,
      instanceRole: InstanceRole.MEMBER,
    });
    await expect(db.membership.count({ where: { userId: fixture.secondUser.id } })).resolves.toBe(
      0,
    );
    await expect(
      db.localCredential.count({ where: { userId: fixture.secondUser.id } }),
    ).resolves.toBe(0);
    await expect(db.account.count({ where: { userId: fixture.secondUser.id } })).resolves.toBe(0);
    await expect(
      db.instanceAuditLog.findFirstOrThrow({
        where: { targetUserId: fixture.secondUser.id, action: "USER_SOFT_DELETED" },
      }),
    ).resolves.toBeTruthy();
  });

  it("admin delivery procedures never return raw setup tokens", async () => {
    const fixture = await setupAdmin();
    vi.stubEnv("AUTH_URL", "https://forge.example");
    const caller = instanceAdminRouter.createCaller(await buildContext(fixture));
    const result = await caller.createUser({
      email: `router-invite-${Date.now()}@example.com`,
      name: "Router Invite",
    });
    extraUserIds.push(result.user.id);
    expect(result).toMatchObject({
      user: { status: UserStatus.INVITED },
      delivery: { messageId: "test-account-setup", expiresAt: expect.any(Date) },
    });
    expect(JSON.stringify(result)).not.toContain("setupToken");
    expect(JSON.stringify(result)).not.toContain("tokenHash");
  });
});
