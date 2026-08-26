import "server-only";

import {
  ApiKeyKind,
  ConnectionStatus,
  IntegrationCredentialSource,
  IntegrationPrincipalType,
  InstanceRole,
  Prisma,
  type PrismaClient,
  UserActionTokenType,
  UserStatus,
} from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { hashPassword } from "@/server/services/local-credentials";
import {
  consumeUserActionToken,
  issueUserActionToken as issueAuthActionToken,
} from "@/server/services/auth-tokens";
import { removeUserAvatar } from "@/server/services/user-avatar";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const SERIALIZABLE_RETRIES = 3;

function transactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

async function serializable<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!transactionConflict(error) || attempt >= SERIALIZABLE_RETRIES - 1) throw error;
    }
  }
}

async function writeInstanceAudit(
  tx: DatabaseClient,
  input: {
    actorId?: string | null;
    targetUserId?: string | null;
    action: string;
    metadata?: Prisma.InputJsonValue;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await tx.instanceAuditLog.create({
    data: {
      actorId: input.actorId,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      metadata: input.metadata ?? {},
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

async function actionTokenTtlMinutes(tx: DatabaseClient): Promise<number> {
  const policy = await tx.instanceAuthPolicy.findUnique({
    where: { id: "default" },
    select: { passwordResetTtlMinutes: true },
  });
  return policy?.passwordResetTtlMinutes ?? 60;
}

async function createActionToken(
  tx: DatabaseClient,
  input: {
    userId: string;
    type: UserActionTokenType;
    emailSnapshot: string;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const now = new Date();
  const ttlMinutes = await actionTokenTtlMinutes(tx);
  const issued = await issueAuthActionToken(
    {
      userId: input.userId,
      type: input.type,
      emailSnapshot: input.emailSnapshot,
      ttlMinutes,
      now,
    },
    tx,
  );
  return { token: issued.rawToken, expiresAt: issued.token.expiresAt };
}

export type LifecycleActor = {
  actorId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type CompletedCredentialAction = { userId: string; authVersion: number };

async function passwordPolicy(db: DatabaseClient): Promise<{ minLength: number }> {
  const policy = await db.instanceAuthPolicy.findUnique({
    where: { id: "default" },
    select: { passwordMinLength: true },
  });
  return { minLength: policy?.passwordMinLength ?? 12 };
}

function assertPasswordLength(password: string, minLength: number): void {
  if (password.length < minLength) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Password must be at least ${minLength} characters.`,
    });
  }
}

async function assertNotDesignatedBreakGlass(
  tx: DatabaseClient,
  userId: string,
  action: string,
): Promise<void> {
  const policy = await tx.instanceAuthPolicy.findUnique({
    where: { id: "default" },
    select: { breakGlassCredentialsEnabled: true, breakGlassUserId: true },
  });
  if (policy?.breakGlassCredentialsEnabled && policy.breakGlassUserId === userId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Reassign or disable break-glass recovery before ${action} its designated administrator.`,
    });
  }
}

export async function createInvitedUser(
  db: PrismaClient,
  input: LifecycleActor & { email: string; name?: string | null; instanceRole?: InstanceRole },
) {
  const email = input.email.trim().toLowerCase();
  return serializable(db, async (tx) => {
    const existing = await tx.user.findFirst({
      where: {
        OR: [{ normalizedEmail: email }, { email: { equals: email, mode: "insensitive" } }],
      },
      select: { id: true },
    });
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "A user with that email already exists." });
    }

    const user = await tx.user.create({
      data: {
        email,
        normalizedEmail: email,
        name: input.name?.trim() || null,
        instanceRole: input.instanceRole ?? InstanceRole.MEMBER,
        status: UserStatus.INVITED,
      },
      select: {
        id: true,
        email: true,
        normalizedEmail: true,
        name: true,
        instanceRole: true,
        status: true,
        createdAt: true,
      },
    });
    const setup = await createActionToken(tx, {
      userId: user.id,
      type: UserActionTokenType.ACCOUNT_SETUP,
      emailSnapshot: user.normalizedEmail ?? user.email.trim().toLowerCase(),
    });
    await writeInstanceAudit(tx, {
      ...input,
      targetUserId: user.id,
      action: "USER_INVITED",
      metadata: { email: user.normalizedEmail, instanceRole: user.instanceRole },
    });
    return { user, setupToken: setup.token, expiresAt: setup.expiresAt };
  });
}

export async function setUserInstanceRole(
  db: PrismaClient,
  input: LifecycleActor & { userId: string; role: InstanceRole },
) {
  return serializable(db, async (tx) => {
    if (input.role !== InstanceRole.INSTANCE_ADMIN) {
      await assertNotDesignatedBreakGlass(tx, input.userId, "demoting");
    }
    const target = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, instanceRole: true, status: true },
    });
    if (!target || target.status === UserStatus.DELETED) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    }
    if (target.instanceRole === input.role) {
      const current = await tx.user.findUniqueOrThrow({
        where: { id: target.id },
        select: { id: true, instanceRole: true, authVersion: true },
      });
      return current;
    }
    if (
      target.instanceRole === InstanceRole.INSTANCE_ADMIN &&
      input.role !== InstanceRole.INSTANCE_ADMIN &&
      target.status === UserStatus.ACTIVE
    ) {
      const otherActiveAdmins = await tx.user.count({
        where: {
          id: { not: target.id },
          instanceRole: InstanceRole.INSTANCE_ADMIN,
          status: UserStatus.ACTIVE,
          disabledAt: null,
          deletedAt: null,
        },
      });
      if (otherActiveAdmins === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Can't demote the last active instance admin.",
        });
      }
    }
    const updated = await tx.user.update({
      where: { id: target.id },
      data: { instanceRole: input.role, authVersion: { increment: 1 } },
      select: { id: true, instanceRole: true, authVersion: true },
    });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await writeInstanceAudit(tx, {
      ...input,
      targetUserId: target.id,
      action: "USER_INSTANCE_ROLE_CHANGED",
      metadata: { before: target.instanceRole, after: updated.instanceRole },
    });
    return updated;
  });
}

export async function issueUserActionToken(
  db: PrismaClient,
  input: LifecycleActor & { userId: string; type: UserActionTokenType },
) {
  return serializable(db, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        normalizedEmail: true,
        status: true,
        localCredential: { select: { userId: true } },
      },
    });
    if (!user || user.status === UserStatus.DELETED) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    }
    if (input.type === UserActionTokenType.ACCOUNT_SETUP && user.status !== UserStatus.INVITED) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Account setup is only available for invited users.",
      });
    }
    if (
      input.type === UserActionTokenType.PASSWORD_RESET &&
      (!user.localCredential ||
        (user.status !== UserStatus.ACTIVE && user.status !== UserStatus.SUSPENDED))
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Password reset is only available for users with a local password.",
      });
    }
    const issued = await createActionToken(tx, {
      userId: user.id,
      type: input.type,
      emailSnapshot: user.normalizedEmail ?? user.email.trim().toLowerCase(),
    });
    await writeInstanceAudit(tx, {
      ...input,
      targetUserId: user.id,
      action:
        input.type === UserActionTokenType.ACCOUNT_SETUP
          ? "ACCOUNT_SETUP_TOKEN_ISSUED"
          : "PASSWORD_RESET_TOKEN_ISSUED",
      metadata: { expiresAt: issued.expiresAt.toISOString() },
    });
    return issued;
  });
}

/**
 * Resolve an eligible local account and rotate its reset token. Callers must
 * always render the same response whether this returns a delivery or null.
 */
export async function requestPasswordReset(
  db: PrismaClient,
  input: { email: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<{ userId: string; email: string; token: string; expiresAt: Date } | null> {
  const normalizedEmail = input.email.trim().toLowerCase();
  return serializable(db, async (tx) => {
    const user = await tx.user.findFirst({
      where: {
        OR: [{ normalizedEmail }, { email: { equals: normalizedEmail, mode: "insensitive" } }],
        status: { in: [UserStatus.ACTIVE, UserStatus.SUSPENDED] },
        deletedAt: null,
        localCredential: { isNot: null },
      },
      select: { id: true, email: true, normalizedEmail: true },
    });
    if (!user) return null;
    const issued = await createActionToken(tx, {
      userId: user.id,
      type: UserActionTokenType.PASSWORD_RESET,
      emailSnapshot: user.normalizedEmail ?? user.email.trim().toLowerCase(),
    });
    await writeInstanceAudit(tx, {
      actorId: null,
      targetUserId: user.id,
      action: "PASSWORD_RESET_REQUESTED",
      metadata: { expiresAt: issued.expiresAt.toISOString() },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
    return { userId: user.id, email: user.email, ...issued };
  });
}

async function completeCredentialAction(
  db: PrismaClient,
  input: {
    token: string;
    password: string;
    type: UserActionTokenType;
    name?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<CompletedCredentialAction> {
  const policy = await passwordPolicy(db);
  assertPasswordLength(input.password, policy.minLength);
  const passwordHash = await hashPassword(input.password);
  const consumed = await consumeUserActionToken(
    { rawToken: input.token, type: input.type },
    async (tx, token) => {
      const now = new Date();
      const tokenUser = await tx.user.findUnique({
        where: { id: token.userId },
        select: { id: true, email: true, normalizedEmail: true, status: true },
      });
      const validStatus =
        input.type === UserActionTokenType.ACCOUNT_SETUP
          ? tokenUser?.status === UserStatus.INVITED
          : tokenUser?.status === UserStatus.ACTIVE || tokenUser?.status === UserStatus.SUSPENDED;
      const currentEmail = tokenUser?.normalizedEmail ?? tokenUser?.email.trim().toLowerCase();
      if (!tokenUser || !validStatus || token.emailSnapshot !== currentEmail) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This account link is invalid or expired.",
        });
      }

      await tx.localCredential.upsert({
        where: { userId: tokenUser.id },
        create: { userId: tokenUser.id, passwordHash, passwordChangedAt: now },
        update: {
          passwordHash,
          passwordChangedAt: now,
          mustChangePassword: false,
          failedAttempts: 0,
          lastFailedAt: null,
          lockedUntil: null,
        },
      });
      await tx.userActionToken.updateMany({
        where: { userId: tokenUser.id, id: { not: token.id }, usedAt: null },
        data: { usedAt: now },
      });
      await tx.session.deleteMany({ where: { userId: tokenUser.id } });
      const user = await tx.user.update({
        where: { id: tokenUser.id },
        data: {
          ...(input.type === UserActionTokenType.ACCOUNT_SETUP
            ? {
                status: UserStatus.ACTIVE,
                disabledAt: null,
                emailVerified: now,
                ...(input.name?.trim() ? { name: input.name.trim() } : {}),
              }
            : {}),
          authVersion: { increment: 1 },
        },
        select: { id: true, authVersion: true },
      });
      await writeInstanceAudit(tx, {
        actorId: user.id,
        targetUserId: user.id,
        action:
          input.type === UserActionTokenType.ACCOUNT_SETUP
            ? "ACCOUNT_SETUP_COMPLETED"
            : "PASSWORD_RESET_COMPLETED",
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      return { userId: user.id, authVersion: user.authVersion };
    },
    db,
  );
  if (consumed.state !== "CONSUMED" || !consumed.value) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This account link is invalid or expired.",
    });
  }
  return consumed.value;
}

export function completePasswordReset(
  db: PrismaClient,
  input: { token: string; password: string; ipAddress?: string | null; userAgent?: string | null },
): Promise<CompletedCredentialAction> {
  return completeCredentialAction(db, { ...input, type: UserActionTokenType.PASSWORD_RESET });
}

export function completeAccountSetup(
  db: PrismaClient,
  input: {
    token: string;
    password: string;
    name?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<CompletedCredentialAction> {
  return completeCredentialAction(db, { ...input, type: UserActionTokenType.ACCOUNT_SETUP });
}

async function assertLifecycleQuorum(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await assertNotDesignatedBreakGlass(tx, userId, "disabling or deleting");
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { instanceRole: true, status: true },
  });
  if (!user || user.status === UserStatus.DELETED) {
    throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
  }

  if (user.instanceRole === InstanceRole.INSTANCE_ADMIN && user.status === UserStatus.ACTIVE) {
    const otherAdmins = await tx.user.count({
      where: {
        id: { not: userId },
        instanceRole: InstanceRole.INSTANCE_ADMIN,
        status: UserStatus.ACTIVE,
        disabledAt: null,
        deletedAt: null,
      },
    });
    if (otherAdmins === 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Can't disable or delete the last active instance admin.",
      });
    }
  }

  const owned = await tx.membership.findMany({
    where: { userId, role: "OWNER", workspace: { deletedAt: null } },
    select: { workspaceId: true, workspace: { select: { name: true } } },
  });
  for (const membership of owned) {
    const otherOwners = await tx.membership.count({
      where: {
        workspaceId: membership.workspaceId,
        userId: { not: userId },
        role: "OWNER",
        user: { status: UserStatus.ACTIVE, disabledAt: null, deletedAt: null },
      },
    });
    if (otherOwners === 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Transfer ownership of ${membership.workspace.name} before disabling or deleting this user.`,
      });
    }
  }
}

async function revokeUserAccess(
  tx: Prisma.TransactionClient,
  userId: string,
  now: Date,
  reason: string,
  revokedById: string | null,
): Promise<{
  sessions: number;
  apiKeys: number;
  connections: number;
  mappings: number;
  connectionAuthorizations: number;
  integrationGrants: number;
}> {
  const connections = await tx.connection.findMany({
    where: { ownerId: userId },
    select: {
      id: true,
      mappings: {
        select: {
          id: true,
          authorization: {
            select: { id: true, credentialSource: true, revokedAt: true },
          },
        },
      },
    },
  });
  const personalMappings = connections.flatMap((connection) =>
    connection.mappings.filter(
      (mapping) =>
        !mapping.authorization ||
        mapping.authorization.credentialSource === IntegrationCredentialSource.USER_CONNECTION,
    ),
  );
  const personalMappingIds = personalMappings.map((mapping) => mapping.id);
  const personalAuthorizationIds = personalMappings.flatMap((mapping) =>
    mapping.authorization && !mapping.authorization.revokedAt ? [mapping.authorization.id] : [],
  );
  const disconnectConnectionIds = connections
    .filter(
      (connection) =>
        !connection.mappings.some(
          (mapping) =>
            mapping.authorization?.credentialSource ===
              IntegrationCredentialSource.WORKSPACE_GITHUB_APP && !mapping.authorization.revokedAt,
        ),
    )
    .map((connection) => connection.id);
  const [sessions, apiKeys, actionTokens, mappings, authorizations, integrationGrants] =
    await Promise.all([
      tx.session.deleteMany({ where: { userId } }),
      // userId is the human principal for PERSONAL / SESSION keys, but only
      // issuer attribution for AGENT service credentials. Disabling a person
      // must not take an independently operated agent or plugin offline.
      tx.apiKey.updateMany({
        where: {
          userId,
          kind: { in: [ApiKeyKind.PERSONAL, ApiKeyKind.SESSION] },
          pluginId: null,
          linkedAgentId: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      }),
      tx.userActionToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } }),
      personalMappingIds.length
        ? tx.connectionMapping.updateMany({
            where: { id: { in: personalMappingIds } },
            data: { status: "paused" },
          })
        : Promise.resolve({ count: 0 }),
      personalAuthorizationIds.length
        ? tx.connectionAuthorization.updateMany({
            where: {
              id: { in: personalAuthorizationIds },
              credentialSource: IntegrationCredentialSource.USER_CONNECTION,
              revokedAt: null,
            },
            data: { revokedAt: now, revokedById },
          })
        : Promise.resolve({ count: 0 }),
      tx.integrationGrant.updateMany({
        where: {
          principalType: IntegrationPrincipalType.USER,
          principalUserId: userId,
          revokedAt: null,
        },
        data: { revokedAt: now, revokedById },
      }),
    ]);
  if (disconnectConnectionIds.length) {
    await tx.connection.updateMany({
      where: { id: { in: disconnectConnectionIds } },
      data: { tokenEnc: null, status: ConnectionStatus.DISCONNECTED, error: reason },
    });
  }
  void actionTokens;
  return {
    sessions: sessions.count,
    apiKeys: apiKeys.count,
    connections: disconnectConnectionIds.length,
    mappings: mappings.count,
    connectionAuthorizations: authorizations.count,
    integrationGrants: integrationGrants.count,
  };
}

export async function revokeUserSessions(
  db: PrismaClient,
  input: LifecycleActor & { userId: string },
) {
  return serializable(db, async (tx) => {
    const user = await tx.user.update({
      where: { id: input.userId },
      data: { authVersion: { increment: 1 } },
      select: { id: true, authVersion: true },
    });
    const sessions = await tx.session.deleteMany({ where: { userId: user.id } });
    await writeInstanceAudit(tx, {
      ...input,
      targetUserId: user.id,
      action: "USER_SESSIONS_REVOKED",
      metadata: { deletedDatabaseSessions: sessions.count, authVersion: user.authVersion },
    });
    return { authVersion: user.authVersion, revokedSessions: sessions.count };
  });
}

export async function suspendUser(
  db: PrismaClient,
  input: LifecycleActor & { userId: string; reason?: string | null },
) {
  return serializable(db, async (tx) => {
    await assertLifecycleQuorum(tx, input.userId);
    const now = new Date();
    const user = await tx.user.update({
      where: { id: input.userId },
      data: { status: UserStatus.SUSPENDED, disabledAt: now, authVersion: { increment: 1 } },
      select: { id: true, status: true, disabledAt: true, authVersion: true },
    });
    const revoked = await revokeUserAccess(
      tx,
      user.id,
      now,
      "Owner account suspended.",
      input.actorId ?? null,
    );
    await writeInstanceAudit(tx, {
      ...input,
      targetUserId: user.id,
      action: "USER_SUSPENDED",
      metadata: { reason: input.reason ?? null, ...revoked, authVersion: user.authVersion },
    });
    return { ...user, revoked };
  });
}

export async function reactivateUser(db: PrismaClient, input: LifecycleActor & { userId: string }) {
  return serializable(db, async (tx) => {
    const existing = await tx.user.findUnique({
      where: { id: input.userId },
      select: { status: true },
    });
    if (!existing || existing.status === UserStatus.DELETED) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    }
    if (existing.status !== UserStatus.SUSPENDED) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Only suspended users can be reactivated.",
      });
    }
    const user = await tx.user.update({
      where: { id: input.userId },
      data: { status: UserStatus.ACTIVE, disabledAt: null, authVersion: { increment: 1 } },
      select: { id: true, status: true, disabledAt: true, authVersion: true },
    });
    await writeInstanceAudit(tx, { ...input, targetUserId: user.id, action: "USER_REACTIVATED" });
    return user;
  });
}

export async function softDeleteUser(
  db: PrismaClient,
  input: LifecycleActor & { userId: string; reason?: string | null },
) {
  const deleted = await serializable(db, async (tx) => {
    await assertLifecycleQuorum(tx, input.userId);
    const now = new Date();
    const tombstoneEmail = `deleted+${input.userId}@invalid.local`;
    const revoked = await revokeUserAccess(
      tx,
      input.userId,
      now,
      "Owner account deleted.",
      input.actorId ?? null,
    );

    await Promise.all([
      tx.localCredential.deleteMany({ where: { userId: input.userId } }),
      tx.account.deleteMany({ where: { userId: input.userId } }),
      tx.workspace.updateMany({
        where: { defaultIssueAssigneeUserId: input.userId },
        data: { defaultIssueAssigneeMode: "NONE", defaultIssueAssigneeUserId: null },
      }),
      tx.membership.deleteMany({ where: { userId: input.userId } }),
    ]);

    const user = await tx.user.update({
      where: { id: input.userId },
      data: {
        email: tombstoneEmail,
        normalizedEmail: tombstoneEmail,
        name: "Deleted user",
        handle: null,
        image: null,
        status: UserStatus.DELETED,
        instanceRole: InstanceRole.MEMBER,
        disabledAt: now,
        deletedAt: now,
        authVersion: { increment: 1 },
      },
      select: { id: true, status: true, deletedAt: true, authVersion: true },
    });
    await writeInstanceAudit(tx, {
      ...input,
      targetUserId: user.id,
      action: "USER_SOFT_DELETED",
      metadata: { reason: input.reason ?? null, ...revoked, authVersion: user.authVersion },
    });
    return { ...user, revoked };
  });
  try {
    const avatarCleanup = await removeUserAvatar(input.userId, { restoreFallback: false });
    return { ...deleted, avatarCleanup: { ok: true as const, ...avatarCleanup } };
  } catch (error) {
    // The durable access revocation and tombstone have already committed. Do
    // not resurrect the account because object storage is unavailable; expose
    // and log the orphan so maintenance can retry cleanup safely.
    const message = error instanceof Error ? error.message : "Avatar cleanup failed.";
    console.error(`[user-lifecycle] avatar cleanup failed for ${input.userId}: ${message}`);
    return { ...deleted, avatarCleanup: { ok: false as const, error: message } };
  }
}
