import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PluginScope, ApiKeyKind } from "@prisma/client";
import type { ApiKey, Prisma, PrismaClient, Role } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { router, adminProcedure, workspaceProcedure } from "@/server/trpc";
import { revokeAgentConnectionsForApiKey } from "@/server/services/agent-connection";
import { agentId as agentIdSchema } from "./agent";

function generateApiKey(prefix = "forge_sk"): { raw: string; hashed: string; prefix: string } {
  const rawBytes = randomBytes(32).toString("base64url");
  const raw = `${prefix}_${rawBytes}`;
  const hashed = createHash("sha256").update(raw).digest("hex");
  return { raw, hashed, prefix: raw.slice(0, prefix.length + 9) };
}

type NarrowIds = {
  projectIds?: string[];
  labelIds?: string[];
  initiativeIds?: string[];
};

function isAdminRole(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function isUserOwnedKey(
  key: Pick<ApiKey, "kind" | "userId" | "pluginId" | "linkedAgentId">,
  userId: string,
): boolean {
  return (
    key.userId === userId &&
    key.pluginId === null &&
    key.linkedAgentId === null &&
    (key.kind === ApiKeyKind.PERSONAL || key.kind === ApiKeyKind.SESSION)
  );
}

function assertCanManageKey(
  key: Pick<ApiKey, "kind" | "userId" | "pluginId" | "linkedAgentId">,
  userId: string,
  role: Role,
): void {
  if (isAdminRole(role) || isUserOwnedKey(key, userId)) return;
  throw new TRPCError({ code: "NOT_FOUND" });
}

function assertUserScopesAllowed(scopes: PluginScope[], role: Role): void {
  if (scopes.includes(PluginScope.ADMIN) && !isAdminRole(role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace administrators may issue an ADMIN-scoped key.",
    });
  }
}

async function auditApiKey(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    actorId: string;
    keyId: string;
    action: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entity: "ApiKey",
      entityId: input.keyId,
      action: input.action,
      before: input.before,
      after: input.after,
      ip: input.ip ?? undefined,
      userAgent: input.userAgent ?? undefined,
    },
  });
}

function keyAuditMetadata(key: {
  name: string;
  prefix: string;
  kind: ApiKeyKind;
  scopes: PluginScope[];
  projectIds: string[];
  labelIds: string[];
  initiativeIds: string[];
  linkedAgentId: string | null;
  userId: string | null;
  pluginId: string | null;
  expiresAt: Date | null;
  revokedAt?: Date | null;
}): Prisma.InputJsonValue {
  return {
    name: key.name,
    prefix: key.prefix,
    kind: key.kind,
    scopes: key.scopes,
    projectIds: key.projectIds,
    labelIds: key.labelIds,
    initiativeIds: key.initiativeIds,
    linkedAgentId: key.linkedAgentId,
    userId: key.userId,
    pluginId: key.pluginId,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Confirm every id in `ids` belongs to `workspaceId` for the given entity.
 * Used when creating/updating API keys with narrowing — we don't want a
 * caller scoping a key to a project that isn't in their workspace.
 */
async function assertIdsInWorkspace(
  db: PrismaClient,
  workspaceId: string,
  ids: NarrowIds,
): Promise<void> {
  const checks: Array<Promise<void>> = [];
  if (ids.projectIds?.length) {
    const unique = Array.from(new Set(ids.projectIds));
    checks.push(
      db.project.count({ where: { id: { in: unique }, workspaceId } }).then((n) => {
        if (n !== unique.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more projectIds not in this workspace.",
          });
        }
      }),
    );
  }
  if (ids.labelIds?.length) {
    const unique = Array.from(new Set(ids.labelIds));
    checks.push(
      db.label.count({ where: { id: { in: unique }, workspaceId } }).then((n) => {
        if (n !== unique.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more labelIds not in this workspace.",
          });
        }
      }),
    );
  }
  if (ids.initiativeIds?.length) {
    const unique = Array.from(new Set(ids.initiativeIds));
    checks.push(
      db.initiative.count({ where: { id: { in: unique }, workspaceId } }).then((n) => {
        if (n !== unique.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more initiativeIds not in this workspace.",
          });
        }
      }),
    );
  }
  await Promise.all(checks);
}

const narrowingInput = {
  projectIds: z.array(z.string().cuid()).default([]),
  labelIds: z.array(z.string().cuid()).default([]),
  initiativeIds: z.array(z.string().cuid()).default([]),
  /**
   * Optional — bind this key to a specific Agent so MCP tools that key off
   * `ApiKeyContext.linkedAgentId` (e.g. `issues.assigned` default agent) can
   * resolve without a `profileKey` on every call. Must be an agent in the
   * same workspace.
   */
  linkedAgentId: agentIdSchema.nullable().optional(),
};

/**
 * Confirm `agentId` (if provided) belongs to `workspaceId`. Mirrors
 * `assertIdsInWorkspace` but for a single nullable agent reference — we
 * don't want a caller linking a key to an agent in a different tenant.
 */
async function assertAgentInWorkspace(
  db: PrismaClient,
  workspaceId: string,
  agentId: string | null | undefined,
): Promise<void> {
  if (!agentId) return;
  const count = await db.agent.count({ where: { id: agentId, workspaceId } });
  if (count === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "linkedAgentId not in this workspace.",
    });
  }
}

/**
 * Workspace-level API keys — not tied to a plugin. Scoped to the user who
 * creates them so they can drive MCP + webhook integrations from external
 * agents (Claude Desktop, Hermes, etc.) without going through the plugin
 * manifest flow.
 */
export const accessRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) =>
    ctx.db.apiKey.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        pluginId: null,
        ...(isAdminRole(ctx.membership.role)
          ? {}
          : {
              userId: ctx.session.user.id,
              linkedAgentId: null,
              kind: { in: [ApiKeyKind.PERSONAL, ApiKeyKind.SESSION] },
            }),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        kind: true,
        scopes: true,
        projectIds: true,
        labelIds: true,
        initiativeIds: true,
        linkedAgentId: true,
        linkedAgent: {
          select: { id: true, name: true, profileKey: true, avatar: true },
        },
        agentConnections: {
          orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
          select: {
            id: true,
            status: true,
            displayName: true,
            clientName: true,
            lastSeenAt: true,
            _count: {
              select: {
                ownedSessions: {
                  where: { status: { notIn: ["VERIFIED", "ABANDONED"] } },
                },
              },
            },
          },
        },
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        userId: true,
      },
    }),
  ),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.nativeEnum(PluginScope)).min(1),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        /// Optional override. If omitted: AGENT when linkedAgentId is set,
        /// PERSONAL otherwise.
        kind: z.nativeEnum(ApiKeyKind).optional(),
        ...narrowingInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertIdsInWorkspace(ctx.db, ctx.workspaceId, {
        projectIds: input.projectIds,
        labelIds: input.labelIds,
        initiativeIds: input.initiativeIds,
      });
      await assertAgentInWorkspace(ctx.db, ctx.workspaceId, input.linkedAgentId);
      const { raw, hashed, prefix } = generateApiKey();
      const inferredKind: ApiKeyKind = input.kind ?? (input.linkedAgentId ? "AGENT" : "PERSONAL");
      if (inferredKind === ApiKeyKind.AGENT && !input.linkedAgentId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "AGENT keys must be linked to an agent.",
        });
      }
      if (inferredKind !== ApiKeyKind.AGENT && input.linkedAgentId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${inferredKind} keys cannot be linked to an agent.`,
        });
      }
      const row = await ctx.db.$transaction(async (tx) => {
        const created = await tx.apiKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            kind: inferredKind,
            name: input.name,
            hashedKey: hashed,
            prefix,
            scopes: input.scopes,
            projectIds: input.projectIds,
            labelIds: input.labelIds,
            initiativeIds: input.initiativeIds,
            linkedAgentId: input.linkedAgentId ?? null,
            expiresAt: input.expiresInDays
              ? new Date(Date.now() + input.expiresInDays * 86_400_000)
              : undefined,
          },
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: created.id,
          action: "create",
          after: keyAuditMetadata(created),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      });
      // rawKey returned once, never persisted.
      return {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        kind: row.kind,
        scopes: row.scopes,
        projectIds: row.projectIds,
        labelIds: row.labelIds,
        initiativeIds: row.initiativeIds,
        linkedAgentId: row.linkedAgentId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        rawKey: raw,
      };
    }),

  /**
   * Edit a key's name or narrowing metadata. Hash and prefix are immutable —
   * for a new secret, call `rotate`. Scope array is also immutable here;
   * shrinking/expanding scopes means issuing a new key.
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(80).optional(),
        projectIds: z.array(z.string().cuid()).optional(),
        labelIds: z.array(z.string().cuid()).optional(),
        initiativeIds: z.array(z.string().cuid()).optional(),
        linkedAgentId: agentIdSchema.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const prior = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!prior) throw new TRPCError({ code: "NOT_FOUND" });
      assertCanManageKey(prior, ctx.session.user.id, ctx.membership.role);
      await assertIdsInWorkspace(ctx.db, ctx.workspaceId, {
        projectIds: input.projectIds,
        labelIds: input.labelIds,
        initiativeIds: input.initiativeIds,
      });
      if (input.linkedAgentId !== undefined) {
        if (prior.kind !== ApiKeyKind.AGENT) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${prior.kind} keys cannot be linked to an agent.`,
          });
        }
        await assertAgentInWorkspace(ctx.db, ctx.workspaceId, input.linkedAgentId);
        if (!input.linkedAgentId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "AGENT keys must remain linked." });
        }
      }
      return ctx.db.$transaction(async (tx) => {
        const updated = await tx.apiKey.update({
          where: { id: prior.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.projectIds !== undefined ? { projectIds: input.projectIds } : {}),
            ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
            ...(input.initiativeIds !== undefined ? { initiativeIds: input.initiativeIds } : {}),
            ...(input.linkedAgentId !== undefined ? { linkedAgentId: input.linkedAgentId } : {}),
          },
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: updated.id,
          action: "update",
          before: keyAuditMetadata(prior),
          after: keyAuditMetadata(updated),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return {
          id: updated.id,
          name: updated.name,
          prefix: updated.prefix,
          scopes: updated.scopes,
          projectIds: updated.projectIds,
          labelIds: updated.labelIds,
          initiativeIds: updated.initiativeIds,
          linkedAgentId: updated.linkedAgentId,
          createdAt: updated.createdAt,
          expiresAt: updated.expiresAt,
          revokedAt: updated.revokedAt,
        };
      });
    }),

  revoke: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!key) throw new TRPCError({ code: "NOT_FOUND" });
      assertCanManageKey(key, ctx.session.user.id, ctx.membership.role);
      const revokedAt = new Date();
      return ctx.db.$transaction(async (tx) => {
        await revokeAgentConnectionsForApiKey(tx, key.id, revokedAt);
        const revoked = await tx.apiKey.update({
          where: { id: input.id },
          data: { revokedAt },
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: revoked.id,
          action: "revoke",
          before: keyAuditMetadata(key),
          after: keyAuditMetadata(revoked),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return revoked;
      });
    }),

  delete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!key) throw new TRPCError({ code: "NOT_FOUND" });
      assertCanManageKey(key, ctx.session.user.id, ctx.membership.role);
      return ctx.db.$transaction(async (tx) => {
        await revokeAgentConnectionsForApiKey(tx, key.id);
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: key.id,
          action: "delete",
          before: keyAuditMetadata(key),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return tx.apiKey.delete({ where: { id: input.id } });
      });
    }),

  /**
   * Create a user-owned personal access token (no agent link). Permanent
   * until revoked. Suitable for local Claude Code sessions, scripts, or
   * one-off integrations.
   */
  createPersonal: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.nativeEnum(PluginScope)).min(1),
        projectIds: z.array(z.string().cuid()).default([]),
        labelIds: z.array(z.string().cuid()).default([]),
        initiativeIds: z.array(z.string().cuid()).default([]),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertUserScopesAllowed(input.scopes, ctx.membership.role);
      await assertIdsInWorkspace(ctx.db, ctx.workspaceId, {
        projectIds: input.projectIds,
        labelIds: input.labelIds,
        initiativeIds: input.initiativeIds,
      });
      const { raw, hashed, prefix } = generateApiKey();
      const row = await ctx.db.$transaction(async (tx) => {
        const created = await tx.apiKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            kind: "PERSONAL" as const,
            name: input.name,
            hashedKey: hashed,
            prefix,
            scopes: input.scopes,
            projectIds: input.projectIds,
            labelIds: input.labelIds,
            initiativeIds: input.initiativeIds,
            linkedAgentId: null,
            expiresAt: input.expiresInDays
              ? new Date(Date.now() + input.expiresInDays * 86_400_000)
              : null,
          },
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: created.id,
          action: "create",
          after: keyAuditMetadata(created),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      });
      return { ...row, rawKey: raw };
    }),

  /**
   * Create a TTL-bounded session key. Expires automatically via `expiresAt`.
   * Perfect for ephemeral sessions or one-off tasks.
   */
  createSession: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.nativeEnum(PluginScope)).min(1),
        projectIds: z.array(z.string().cuid()).default([]),
        labelIds: z.array(z.string().cuid()).default([]),
        initiativeIds: z.array(z.string().cuid()).default([]),
        ttlHours: z.number().int().min(1).max(168).default(24),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertUserScopesAllowed(input.scopes, ctx.membership.role);
      await assertIdsInWorkspace(ctx.db, ctx.workspaceId, {
        projectIds: input.projectIds,
        labelIds: input.labelIds,
        initiativeIds: input.initiativeIds,
      });
      const { raw, hashed, prefix } = generateApiKey();
      const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
      const row = await ctx.db.$transaction(async (tx) => {
        const created = await tx.apiKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
            kind: "SESSION" as const,
            name: input.name,
            hashedKey: hashed,
            prefix,
            scopes: input.scopes,
            projectIds: input.projectIds,
            labelIds: input.labelIds,
            initiativeIds: input.initiativeIds,
            linkedAgentId: null,
            expiresAt,
          },
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: created.id,
          action: "create",
          after: keyAuditMetadata(created),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      });
      return { ...row, rawKey: raw };
    }),

  /**
   * Rotate a key — revokes the existing row and issues a new one with the
   * same name + scopes + expiry window (if any). Returns the raw key once.
   * Consumers must update their stored credential.
   */
  rotate: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const prior = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!prior) throw new TRPCError({ code: "NOT_FOUND" });
      assertCanManageKey(prior, ctx.session.user.id, ctx.membership.role);
      if (prior.revokedAt)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Key already revoked." });

      const { raw, hashed, prefix } = generateApiKey();
      const revokedAt = new Date();
      const next = await ctx.db.$transaction(async (tx) => {
        await revokeAgentConnectionsForApiKey(tx, prior.id, revokedAt);
        await tx.apiKey.update({ where: { id: prior.id }, data: { revokedAt } });
        const created = await tx.apiKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: prior.userId,
            kind: prior.kind,
            name: prior.name,
            hashedKey: hashed,
            prefix,
            scopes: prior.scopes,
            // Preserve narrowing on rotation — ops don't want to re-scope
            // an agent's key just because the secret changed.
            projectIds: prior.projectIds,
            labelIds: prior.labelIds,
            initiativeIds: prior.initiativeIds,
            linkedAgentId: prior.linkedAgentId,
            expiresAt: prior.expiresAt
              ? new Date(
                  Date.now() + Math.max(1, prior.expiresAt.getTime() - prior.createdAt.getTime()),
                )
              : null,
          },
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: prior.id,
          action: "rotate-from",
          before: keyAuditMetadata(prior),
          after: keyAuditMetadata({ ...prior, revokedAt }),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await auditApiKey(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          keyId: created.id,
          action: "rotate-to",
          after: keyAuditMetadata(created),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      });
      return {
        id: next.id,
        name: next.name,
        prefix: next.prefix,
        kind: next.kind,
        scopes: next.scopes,
        projectIds: next.projectIds,
        labelIds: next.labelIds,
        initiativeIds: next.initiativeIds,
        linkedAgentId: next.linkedAgentId,
        createdAt: next.createdAt,
        expiresAt: next.expiresAt,
        rawKey: raw,
      };
    }),
});
