import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  AgentProvider,
  AgentRole,
  AgentRuntimeMode,
  RunEngine,
  type PrismaClient,
} from "@prisma/client";
import { router, globalProcedure, protectedProcedure, instanceAdminProcedure } from "@/server/trpc";

/**
 * Global agent **profiles** — the user-owned definitions in the
 * three-tier model (definition → binding → instance policy). Reads are
 * cross-workspace (`globalProcedure`); **creating** a profile requires
 * INSTANCE_ADMIN (members see a "requires instance admin" affordance in
 * the bind catalog). Owners may edit/archive their own profiles; instance
 * admins may edit any, mark instance-shared, and force-disable.
 *
 * Part of the multi-workspace restructure (docs/plans/multiws-restructure.md).
 */

const profileKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Lowercase, digits, `-` or `_` only");

async function instanceRoleOf(db: PrismaClient, userId: string) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { instanceRole: true } });
  return u?.instanceRole ?? "MEMBER";
}

/** Throws unless the caller owns the profile or is an instance admin. */
async function assertCanEdit(db: PrismaClient, userId: string, profileId: string) {
  const p = await db.agentProfile.findUnique({
    where: { id: profileId },
    select: { ownerId: true },
  });
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
  if (p.ownerId === userId) return;
  if ((await instanceRoleOf(db, userId)) === "INSTANCE_ADMIN") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the owner or an instance admin can edit this profile.",
  });
}

export const agentProfileRouter = router({
  /** Owned + instance-shared profiles, with cross-workspace binding summary. */
  list: globalProcedure.query(async ({ ctx }) => {
    const profiles = await ctx.db.agentProfile.findMany({
      where: { archivedAt: null, OR: [{ ownerId: ctx.session.user.id }, { instanceShared: true }] },
      orderBy: { createdAt: "asc" },
      include: {
        runtime: { select: { id: true, name: true, kind: true } },
        bindings: {
          where: { archivedAt: null },
          select: {
            id: true,
            status: true,
            maxConcurrent: true,
            autoDispatchEligible: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    return profiles.map((p) => ({
      ...p,
      ownedByMe: p.ownerId === ctx.session.user.id,
      online: p.bindings.some((b) => b.status === "ONLINE" || b.status === "BUSY"),
    }));
  }),

  /** Single profile (owner / instance-shared / admin) with bindings + recent cross-WS runs. */
  get: globalProcedure.input(z.object({ id: z.string().cuid() })).query(async ({ ctx, input }) => {
    const p = await ctx.db.agentProfile.findUnique({
      where: { id: input.id },
      include: {
        runtime: { select: { id: true, name: true, kind: true } },
        bindings: {
          where: { archivedAt: null },
          select: {
            id: true,
            status: true,
            maxConcurrent: true,
            autoDispatchEligible: true,
            engagementMode: true,
            capabilities: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
          },
        },
      },
    });
    if (!p) throw new TRPCError({ code: "NOT_FOUND" });
    const instanceRole = await instanceRoleOf(ctx.db, ctx.session.user.id);
    const canEdit = p.ownerId === ctx.session.user.id || instanceRole === "INSTANCE_ADMIN";
    const visible = canEdit || p.instanceShared;
    if (!visible) throw new TRPCError({ code: "FORBIDDEN" });

    // Recent runs across all this profile's bindings (read-only, cross-WS).
    const bindingIds = p.bindings.map((b) => b.id);
    const recentRuns = bindingIds.length
      ? await ctx.db.agentRun.findMany({
          where: { agentId: { in: bindingIds } },
          orderBy: { startedAt: "desc" },
          take: 15,
          select: {
            id: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            currentStep: true,
            tokensIn: true,
            tokensOut: true,
            workspace: { select: { id: true, slug: true, key: true } },
            issue: { select: { id: true, number: true, title: true } },
          },
        })
      : [];
    return { ...p, ownedByMe: p.ownerId === ctx.session.user.id, canEdit, recentRuns };
  }),

  /** Pending profile requests awaiting approval. INSTANCE_ADMIN only. */
  listPending: instanceAdminProcedure.query(async ({ ctx }) => {
    const profiles = await ctx.db.agentProfile.findMany({
      where: { archivedAt: null, approvedAt: null, requestedById: { not: null } },
      orderBy: { createdAt: "desc" },
      include: {
        runtime: { select: { id: true, name: true, kind: true } },
        requestedBy: { select: { id: true, name: true, email: true, image: true } },
      },
    });
    return profiles.map((p) => ({ ...p, requestedAt: p.createdAt }));
  }),

  /**
   * Member-initiated profile request. Any signed-in user creates a PENDING
   * profile (`requestedById` = caller, `approvedAt` = null). Not bindable
   * until an instance admin approves. Owner defaults to the requester so the
   * per-owner unique key constraint applies to their own requests.
   */
  request: protectedProcedure
    .input(
      z.object({
        profileKey: profileKeySchema,
        name: z.string().min(1).max(80),
        description: z.string().max(2000).optional(),
        avatar: z.string().max(2048).optional(),
        provider: z.nativeEnum(AgentProvider).default(AgentProvider.HERMES),
        runEngine: z.nativeEnum(RunEngine).nullish(),
        baseCapabilities: z.array(z.string().min(1).max(40)).default([]),
        templateMarkdown: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ownerId = ctx.session.user.id;
      const dupe = await ctx.db.agentProfile.findUnique({
        where: { ownerId_profileKey: { ownerId, profileKey: input.profileKey } },
        select: { id: true },
      });
      if (dupe)
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have a profile with this key.",
        });
      return ctx.db.agentProfile.create({
        data: {
          ...input,
          ownerId,
          requestedById: ownerId,
          approvedAt: null,
        },
      });
    }),

  /** Instance admin: approve a pending profile request. */
  approve: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const p = await ctx.db.agentProfile.findUnique({
        where: { id: input.id },
        select: { id: true, approvedAt: true },
      });
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      return ctx.db.agentProfile.update({
        where: { id: input.id },
        data: { approvedAt: new Date(), disabledAt: null },
      });
    }),

  /** Instance admin: reject (archive) a pending profile request. */
  reject: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const p = await ctx.db.agentProfile.findUnique({
        where: { id: input.id },
        select: { id: true },
      });
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      return ctx.db.agentProfile.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
    }),

  /** Create a new global profile. INSTANCE_ADMIN only. Owner defaults to the creator. */
  create: instanceAdminProcedure
    .input(
      z.object({
        profileKey: profileKeySchema,
        name: z.string().min(1).max(80),
        description: z.string().max(2000).optional(),
        avatar: z.string().max(2048).optional(),
        provider: z.nativeEnum(AgentProvider).default(AgentProvider.HERMES),
        runtimeMode: z.nativeEnum(AgentRuntimeMode).default(AgentRuntimeMode.PERSISTENT),
        runEngine: z.nativeEnum(RunEngine).nullish(),
        runtimeId: z.string().cuid().nullish(),
        baseCapabilities: z.array(z.string().min(1).max(40)).default([]),
        role: z.nativeEnum(AgentRole).default(AgentRole.WORKER),
        templateMarkdown: z.string().nullish(),
        webhookUrl: z.string().url().max(2048).nullish(),
        instanceShared: z.boolean().default(false),
        ownerId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ownerId = input.ownerId ?? ctx.session.user.id;
      const dupe = await ctx.db.agentProfile.findUnique({
        where: { ownerId_profileKey: { ownerId, profileKey: input.profileKey } },
        select: { id: true },
      });
      if (dupe)
        throw new TRPCError({
          code: "CONFLICT",
          message: "That owner already has a profile with this key.",
        });
      const { ownerId: _drop, ...rest } = input;
      // Admin-created profiles are pre-approved (requestedById stays null).
      return ctx.db.agentProfile.create({ data: { ...rest, ownerId, approvedAt: new Date() } });
    }),

  /** Edit a profile's definition. Owner or instance admin. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(2000).nullish(),
        avatar: z.string().max(2048).nullish(),
        provider: z.nativeEnum(AgentProvider).optional(),
        runtimeMode: z.nativeEnum(AgentRuntimeMode).optional(),
        runEngine: z.nativeEnum(RunEngine).nullish(),
        runtimeId: z.string().cuid().nullish(),
        baseCapabilities: z.array(z.string().min(1).max(40)).optional(),
        role: z.nativeEnum(AgentRole).optional(),
        templateMarkdown: z.string().nullable().optional(),
        webhookUrl: z.string().url().max(2048).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanEdit(ctx.db, ctx.session.user.id, input.id);
      const { id, ...data } = input;
      return ctx.db.$transaction(async (tx) => {
        const profile = await tx.agentProfile.update({ where: { id }, data });
        if (Object.prototype.hasOwnProperty.call(data, "templateMarkdown")) {
          await tx.agent.updateMany({
            where: { profileId: id, archivedAt: null },
            data: { templateMarkdown: data.templateMarkdown ?? null },
          });
        }
        return profile;
      });
    }),

  /** Instance admin: mark a profile available to every workspace's catalog. */
  setInstanceShared: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid(), instanceShared: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.agentProfile.update({
        where: { id: input.id },
        data: { instanceShared: input.instanceShared },
      }),
    ),

  /** Instance admin: force-disable (or re-enable) a profile and all its bindings. */
  setDisabled: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid(), disabled: z.boolean() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.agentProfile.update({
        where: { id: input.id },
        data: { disabledAt: input.disabled ? new Date() : null },
      }),
    ),

  /** Archive a profile (owner or instance admin). Bindings survive via SetNull. */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertCanEdit(ctx.db, ctx.session.user.id, input.id);
      return ctx.db.agentProfile.update({
        where: { id: input.id },
        data: { archivedAt: new Date() },
      });
    }),

  /**
   * Instance admin: smart remove — what the admin UI's "Remove" action calls.
   * Hard-deletes a profile that no workspace has ever bound (the throwaway /
   * mistake case); if any Agent binding still references it, ARCHIVES instead so
   * those bindings aren't orphaned (profile delete is SetNull on the Agent).
   * Archived profiles drop out of the admin list and the bindable catalog.
   */
  remove: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const profile = await ctx.db.agentProfile.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, _count: { select: { bindings: true } } },
      });
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      const boundAgents = profile._count.bindings;
      if (boundAgents > 0) {
        await ctx.db.agentProfile.update({
          where: { id: profile.id },
          data: { archivedAt: new Date() },
        });
        return { action: "archived" as const, name: profile.name, boundAgents };
      }
      await ctx.db.agentProfile.delete({ where: { id: profile.id } });
      return { action: "deleted" as const, name: profile.name, boundAgents: 0 };
    }),
});
