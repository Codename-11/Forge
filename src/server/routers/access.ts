import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PluginScope } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { router, adminProcedure, workspaceProcedure } from "@/server/trpc";

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

/**
 * Confirm every id in `ids` belongs to `workspaceId` for the given entity.
 * Used when creating/updating API keys with narrowing — we don't want a
 * caller scoping a key to a project that isn't in their workspace.
 */
async function assertIdsInWorkspace(
  db: import("@prisma/client").PrismaClient,
  workspaceId: string,
  ids: NarrowIds,
): Promise<void> {
  const checks: Array<Promise<void>> = [];
  if (ids.projectIds?.length) {
    const unique = Array.from(new Set(ids.projectIds));
    checks.push(
      db.project
        .count({ where: { id: { in: unique }, workspaceId } })
        .then((n) => {
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
      db.label
        .count({ where: { id: { in: unique }, workspaceId } })
        .then((n) => {
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
      db.initiative
        .count({ where: { id: { in: unique }, workspaceId } })
        .then((n) => {
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
  linkedAgentId: z.string().cuid().nullable().optional(),
};

/**
 * Confirm `agentId` (if provided) belongs to `workspaceId`. Mirrors
 * `assertIdsInWorkspace` but for a single nullable agent reference — we
 * don't want a caller linking a key to an agent in a different tenant.
 */
async function assertAgentInWorkspace(
  db: import("@prisma/client").PrismaClient,
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
      where: { workspaceId: ctx.workspaceId, pluginId: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        projectIds: true,
        labelIds: true,
        initiativeIds: true,
        linkedAgentId: true,
        linkedAgent: {
          select: { id: true, name: true, profileKey: true, avatar: true },
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
        ...narrowingInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertIdsInWorkspace(ctx.db, ctx.workspaceId, {
        projectIds: input.projectIds,
        labelIds: input.labelIds,
        initiativeIds: input.initiativeIds,
      });
      await assertAgentInWorkspace(
        ctx.db,
        ctx.workspaceId,
        input.linkedAgentId,
      );
      const { raw, hashed, prefix } = generateApiKey();
      const row = await ctx.db.apiKey.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
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
      // rawKey returned once, never persisted.
      return {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
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
  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(80).optional(),
        projectIds: z.array(z.string().cuid()).optional(),
        labelIds: z.array(z.string().cuid()).optional(),
        initiativeIds: z.array(z.string().cuid()).optional(),
        linkedAgentId: z.string().cuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const prior = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!prior) throw new TRPCError({ code: "NOT_FOUND" });
      await assertIdsInWorkspace(ctx.db, ctx.workspaceId, {
        projectIds: input.projectIds,
        labelIds: input.labelIds,
        initiativeIds: input.initiativeIds,
      });
      if (input.linkedAgentId !== undefined) {
        await assertAgentInWorkspace(
          ctx.db,
          ctx.workspaceId,
          input.linkedAgentId,
        );
      }
      return ctx.db.apiKey.update({
        where: { id: prior.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.projectIds !== undefined ? { projectIds: input.projectIds } : {}),
          ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
          ...(input.initiativeIds !== undefined
            ? { initiativeIds: input.initiativeIds }
            : {}),
          ...(input.linkedAgentId !== undefined
            ? { linkedAgentId: input.linkedAgentId }
            : {}),
        },
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          projectIds: true,
          labelIds: true,
          initiativeIds: true,
          linkedAgentId: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!key) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.apiKey.update({
        where: { id: input.id },
        data: { revokedAt: new Date() },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!key) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.db.apiKey.delete({ where: { id: input.id } });
    }),

  /**
   * Rotate a key — revokes the existing row and issues a new one with the
   * same name + scopes + expiry window (if any). Returns the raw key once.
   * Consumers must update their stored credential.
   */
  rotate: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const prior = await ctx.db.apiKey.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, pluginId: null },
      });
      if (!prior) throw new TRPCError({ code: "NOT_FOUND" });
      if (prior.revokedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Key already revoked." });

      const { raw, hashed, prefix } = generateApiKey();
      const [, next] = await ctx.db.$transaction([
        ctx.db.apiKey.update({ where: { id: prior.id }, data: { revokedAt: new Date() } }),
        ctx.db.apiKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            userId: prior.userId,
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
                  Date.now() +
                    Math.max(1, prior.expiresAt.getTime() - prior.createdAt.getTime()),
                )
              : null,
          },
        }),
      ]);
      return {
        id: next.id,
        name: next.name,
        prefix: next.prefix,
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
