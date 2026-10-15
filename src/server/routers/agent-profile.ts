import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { AgentProvider, AgentRole, AgentRuntimeMode, RunEngine, type Prisma } from "@prisma/client";
import { router, globalProcedure, protectedProcedure, instanceAdminProcedure } from "@/server/trpc";
import { issueWhereForViewer } from "@/server/services/project-access";
import {
  agentProfileAvailability,
  canViewAgentWorkspace,
  publicAgentDefinition,
} from "@/server/services/agent-profile-access";
import {
  assertActiveProfileOwner,
  assertProfileRuntimeAvailable,
  auditAgentProfile,
  profileTransaction,
  readAgentPolicy,
  type ProfileDb,
} from "@/server/services/agent-profile-policy";

/**
 * Personal and instance-managed service definitions. Ownership determines who
 * manages the definition; catalog sharing never grants workspace access.
 * Member creation follows explicit instance policy. Service creation, sharing,
 * and ownership transfers require instance administration.
 *
 * Part of the multi-workspace restructure (docs/plans/multiws-restructure.md).
 */

const profileKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Lowercase, digits, `-` or `_` only");

async function instanceRoleOf(db: ProfileDb, userId: string) {
  const u = await db.user.findUnique({ where: { id: userId }, select: { instanceRole: true } });
  return u?.instanceRole ?? "MEMBER";
}

/** Throws unless the caller owns the profile or is an instance admin. */
async function assertCanEdit(db: ProfileDb, userId: string, profileId: string) {
  const p = await db.agentProfile.findUnique({
    where: { id: profileId },
    select: { ownerId: true, ownerType: true },
  });
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
  if (p.ownerType === "PERSONAL" && p.ownerId === userId) return;
  if ((await instanceRoleOf(db, userId)) === "INSTANCE_ADMIN") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the owner or an instance admin can edit this profile.",
  });
}

const ownerTypeSchema = z.enum(["PERSONAL", "SERVICE"]);
const creationPolicySchema = z.enum(["DISABLED", "APPROVAL_REQUIRED", "SELF_SERVICE"]);
const auditActor = (ctx: {
  session: { user: { id: string } };
  ip: string | null;
  userAgent: string | null;
}) => ({ actorId: ctx.session.user.id, ip: ctx.ip, userAgent: ctx.userAgent });

export const agentProfileRouter = router({
  policy: protectedProcedure.query(({ ctx }) => readAgentPolicy(ctx.db)),

  setPolicy: instanceAdminProcedure
    .input(z.object({ personalAgentCreation: creationPolicySchema }))
    .mutation(({ ctx, input }) =>
      profileTransaction(ctx.db, async (tx) => {
        const before = await readAgentPolicy(tx);
        await tx.instanceAgentPolicy.upsert({
          where: { id: "default" },
          create: { id: "default", ...input },
          update: input,
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.policy.updated", {
          before,
          after: input,
        });
        return input;
      }),
    ),

  ownershipCandidates: instanceAdminProcedure.query(({ ctx }) =>
    ctx.db.user.findMany({
      where: { status: "ACTIVE", deletedAt: null, disabledAt: null },
      select: { id: true, name: true, email: true, image: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ),
  /** Owned + instance-shared profiles, with cross-workspace binding summary. */
  list: globalProcedure.query(async ({ ctx }) => {
    const [instanceRole, memberships] = await Promise.all([
      instanceRoleOf(ctx.db, ctx.session.user.id),
      ctx.db.membership.findMany({
        where: { userId: ctx.session.user.id, workspace: { deletedAt: null } },
        select: { workspaceId: true },
      }),
    ]);
    const visibleWorkspaceIds = new Set(memberships.map((membership) => membership.workspaceId));
    const profiles = await ctx.db.agentProfile.findMany({
      where: {
        archivedAt: null,
        ...(instanceRole === "INSTANCE_ADMIN"
          ? {}
          : { OR: [{ ownerId: ctx.session.user.id }, { instanceShared: true }] }),
      },
      orderBy: { createdAt: "asc" },
      include: {
        owner: { select: { id: true, name: true, image: true } },
        createdBy: { select: { id: true, name: true } },
        runtime: { select: { id: true, name: true, kind: true } },
        bindings: {
          where: { archivedAt: null },
          select: {
            id: true,
            status: true,
            maxConcurrent: true,
            autoDispatchEligible: true,
            workspace: { select: { id: true, slug: true, name: true, key: true } },
            _count: { select: { apiKeys: { where: { pluginId: null } } } },
          },
        },
      },
    });
    return profiles.map((p) => {
      const bindings = p.bindings.filter((binding) =>
        canViewAgentWorkspace(
          binding.workspace.id,
          visibleWorkspaceIds,
          instanceRole === "INSTANCE_ADMIN",
        ),
      );
      return {
        ...publicAgentDefinition(p),
        bindings,
        bindingCount: bindings.length,
        availability: agentProfileAvailability(p),
        ownedByMe: p.ownerId === ctx.session.user.id,
        online: bindings.some((b) => b.status === "ONLINE" || b.status === "BUSY"),
        clientCount: bindings.reduce((total, binding) => total + binding._count.apiKeys, 0),
      };
    });
  }),

  /** Single profile (owner / instance-shared / admin) with bindings + recent cross-WS runs. */
  get: globalProcedure.input(z.object({ id: z.string().cuid() })).query(async ({ ctx, input }) => {
    const p = await ctx.db.agentProfile.findUnique({
      where: { id: input.id },
      include: {
        owner: { select: { id: true, name: true, image: true } },
        createdBy: { select: { id: true, name: true } },
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
            apiKeys: {
              where: { pluginId: null },
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                name: true,
                prefix: true,
                kind: true,
                scopes: true,
                lastUsedAt: true,
                expiresAt: true,
                revokedAt: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!p) throw new TRPCError({ code: "NOT_FOUND" });
    const instanceRole = await instanceRoleOf(ctx.db, ctx.session.user.id);
    const canEdit = p.ownerId === ctx.session.user.id || instanceRole === "INSTANCE_ADMIN";
    const visible = canEdit || p.instanceShared;
    if (!visible) throw new TRPCError({ code: "FORBIDDEN" });

    const workspaceIds = p.bindings.map((b) => b.workspace.id);
    const memberships = workspaceIds.length
      ? await ctx.db.membership.findMany({
          where: {
            userId: ctx.session.user.id,
            workspaceId: { in: workspaceIds },
            workspace: { deletedAt: null },
          },
          select: { id: true, workspaceId: true, role: true },
        })
      : [];
    const visibleWorkspaceIds = new Set(memberships.map((membership) => membership.workspaceId));
    const manageableWorkspaceIds = new Set(
      memberships
        .filter((membership) => membership.role === "OWNER" || membership.role === "ADMIN")
        .map((membership) => membership.workspaceId),
    );
    // Managing a definition does not grant access to the workspaces using it.
    const visibleBindings = p.bindings.filter((binding) =>
      canViewAgentWorkspace(
        binding.workspace.id,
        visibleWorkspaceIds,
        instanceRole === "INSTANCE_ADMIN",
      ),
    );
    const bindingIds = visibleBindings.map((binding) => binding.id);
    const recentRuns = bindingIds.length
      ? await ctx.db.agentRun.findMany({
          where: {
            agentId: { in: bindingIds },
            ...(instanceRole === "INSTANCE_ADMIN"
              ? {}
              : {
                  issue: {
                    deletedAt: null,
                    OR: memberships.map((membership) =>
                      issueWhereForViewer({ workspaceId: membership.workspaceId, membership }),
                    ),
                  },
                }),
          },
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
    return {
      ...publicAgentDefinition(p),
      bindings: visibleBindings.map((binding) => ({
        ...binding,
        canManage: manageableWorkspaceIds.has(binding.workspace.id),
      })),
      bindingCount: visibleBindings.length,
      availability: agentProfileAvailability(p),
      ownedByMe: p.ownerId === ctx.session.user.id,
      canEdit,
      recentRuns,
    };
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
    return profiles.map((p) => ({ ...publicAgentDefinition(p), requestedAt: p.createdAt }));
  }),

  /**
   * Member-initiated personal setup. Approval follows current instance policy;
   * sharing, alternate ownership, and runtime credentials are never accepted.
   */
  request: protectedProcedure
    .input(
      z
        .object({
          profileKey: profileKeySchema,
          name: z.string().min(1).max(80),
          description: z.string().max(2000).optional(),
          avatar: z.string().max(2048).optional(),
          provider: z.nativeEnum(AgentProvider).default(AgentProvider.HERMES),
          runEngine: z.nativeEnum(RunEngine).nullish(),
          baseCapabilities: z.array(z.string().min(1).max(40)).default([]),
          templateMarkdown: z.string().nullish(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const ownerId = ctx.session.user.id;
      return profileTransaction(ctx.db, async (tx) => {
        const policy = await readAgentPolicy(tx);
        if (policy.personalAgentCreation === "DISABLED") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Personal agent creation is disabled by instance policy.",
          });
        }
        await assertActiveProfileOwner(tx, ownerId);
        const profile = await tx.agentProfile.create({
          data: {
            ...input,
            ownerType: "PERSONAL",
            ownerId,
            createdById: ownerId,
            requestedById: ownerId,
            approvedAt: policy.personalAgentCreation === "SELF_SERVICE" ? new Date() : null,
            instanceShared: false,
          },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.requested", {
          profileId: profile.id,
          ownerType: "PERSONAL",
          ownerId,
          policy: policy.personalAgentCreation,
          approved: Boolean(profile.approvedAt),
        });
        return publicAgentDefinition(profile);
      });
    }),

  /** Instance admin: approve a pending profile request. */
  approve: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return profileTransaction(ctx.db, async (tx) => {
        const p = await tx.agentProfile.findUnique({
          where: { id: input.id },
          select: { id: true, approvedAt: true, ownerId: true },
        });
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
        if (p.ownerId) await assertActiveProfileOwner(tx, p.ownerId);
        const profile = await tx.agentProfile.update({
          where: { id: input.id },
          data: { approvedAt: new Date(), disabledAt: null },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.approved", { profileId: p.id });
        return publicAgentDefinition(profile);
      });
    }),

  /** Instance admin: reject (archive) a pending profile request. */
  reject: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return profileTransaction(ctx.db, async (tx) => {
        const p = await tx.agentProfile.findUnique({
          where: { id: input.id },
          select: { id: true },
        });
        if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
        const profile = await tx.agentProfile.update({
          where: { id: input.id },
          data: { archivedAt: new Date() },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.rejected", { profileId: p.id });
        return publicAgentDefinition(profile);
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
        ownerType: ownerTypeSchema.default("PERSONAL"),
        ownerId: z.string().cuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ownerType === "SERVICE" && input.ownerId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Service agents are instance-managed and cannot have a personal owner.",
        });
      const ownerId = input.ownerType === "SERVICE" ? null : (input.ownerId ?? ctx.session.user.id);
      const { ownerId: _drop, ...rest } = input;
      return profileTransaction(ctx.db, async (tx) => {
        if (ownerId) await assertActiveProfileOwner(tx, ownerId);
        await assertProfileRuntimeAvailable(tx, input.runtimeId, input.ownerType, ownerId);
        const profile = await tx.agentProfile.create({
          data: { ...rest, ownerId, createdById: ctx.session.user.id, approvedAt: new Date() },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.created", {
          profileId: profile.id,
          ownerType: input.ownerType,
          ownerId,
          instanceShared: input.instanceShared,
        });
        return publicAgentDefinition(profile);
      });
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
      const { id, ...data } = input;
      return profileTransaction(ctx.db, async (tx) => {
        await assertCanEdit(tx, ctx.session.user.id, input.id);
        const current = await tx.agentProfile.findUniqueOrThrow({
          where: { id },
          select: { ownerId: true, ownerType: true },
        });
        if (Object.prototype.hasOwnProperty.call(input, "runtimeId")) {
          await assertProfileRuntimeAvailable(
            tx,
            input.runtimeId,
            current.ownerType === "SERVICE" ? "SERVICE" : "PERSONAL",
            current.ownerId,
          );
        }
        const profile = await tx.agentProfile.update({ where: { id }, data });
        const bindingData: Prisma.AgentUpdateManyMutationInput = {};
        const syncedFields = [
          "name",
          "description",
          "avatar",
          "provider",
          "runtimeMode",
          "runEngine",
          "runtimeId",
          "role",
          "templateMarkdown",
          "webhookUrl",
        ] as const;
        for (const field of syncedFields) {
          if (Object.prototype.hasOwnProperty.call(data, field)) {
            Object.assign(bindingData, { [field]: data[field] ?? null });
          }
        }
        if (Object.keys(bindingData).length > 0) {
          await tx.agent.updateMany({
            where: { profileId: id, archivedAt: null },
            data: bindingData,
          });
        }
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.updated", {
          profileId: id,
          changedFields: Object.keys(data).filter(
            (field) => data[field as keyof typeof data] !== undefined,
          ),
        });
        return publicAgentDefinition(profile);
      });
    }),

  transferOwnership: instanceAdminProcedure
    .input(
      z
        .object({
          id: z.string().cuid(),
          ownerType: ownerTypeSchema,
          ownerId: z.string().cuid().nullish(),
          expectedOwnerType: ownerTypeSchema,
          expectedOwnerId: z.string().cuid().nullable(),
          expectedUpdatedAt: z.date(),
          clearRuntime: z.boolean().default(false),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      profileTransaction(ctx.db, async (tx) => {
        if (input.ownerType === "PERSONAL" && !input.ownerId)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a personal owner." });
        if (input.ownerType === "SERVICE" && input.ownerId)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Service agents cannot have a personal owner.",
          });
        const ownerId = input.ownerType === "SERVICE" ? null : input.ownerId!;
        const current = await tx.agentProfile.findUnique({ where: { id: input.id } });
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
        if (
          current.ownerType !== input.expectedOwnerType ||
          current.ownerId !== input.expectedOwnerId ||
          current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The agent changed since you opened it. Refresh before transferring ownership.",
          });
        }
        if (ownerId) await assertActiveProfileOwner(tx, ownerId);
        if (!input.clearRuntime)
          await assertProfileRuntimeAvailable(tx, current.runtimeId, input.ownerType, ownerId);
        const changed = await tx.agentProfile.updateMany({
          where: {
            id: input.id,
            ownerType: input.expectedOwnerType,
            ownerId: input.expectedOwnerId,
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            ownerType: input.ownerType,
            ownerId,
            ...(input.clearRuntime ? { runtimeId: null } : {}),
          },
        });
        if (changed.count !== 1)
          throw new TRPCError({
            code: "CONFLICT",
            message: "Ownership changed. Refresh before trying again.",
          });
        if (input.clearRuntime)
          await tx.agent.updateMany({ where: { profileId: input.id }, data: { runtimeId: null } });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.ownership_transferred", {
          profileId: input.id,
          before: { ownerType: current.ownerType, ownerId: current.ownerId },
          after: { ownerType: input.ownerType, ownerId },
          clearedRuntime: input.clearRuntime,
        });
        return publicAgentDefinition(
          await tx.agentProfile.findUniqueOrThrow({ where: { id: input.id } }),
        );
      }),
    ),

  /** Instance admin: mark a profile available to every workspace's catalog. */
  setInstanceShared: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid(), instanceShared: z.boolean() }))
    .mutation(({ ctx, input }) =>
      profileTransaction(ctx.db, async (tx) => {
        const before = await tx.agentProfile.findUniqueOrThrow({
          where: { id: input.id },
          select: { instanceShared: true },
        });
        const profile = await tx.agentProfile.update({
          where: { id: input.id },
          data: { instanceShared: input.instanceShared },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.sharing_updated", {
          profileId: input.id,
          before: before.instanceShared,
          after: input.instanceShared,
        });
        return publicAgentDefinition(profile);
      }),
    ),

  /** Instance admin: force-disable (or re-enable) a profile and all its bindings. */
  setDisabled: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid(), disabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      profileTransaction(ctx.db, async (tx) => {
        const profile = await tx.agentProfile.update({
          where: { id: input.id },
          data: { disabledAt: input.disabled ? new Date() : null },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.disabled_updated", {
          profileId: input.id,
          disabled: input.disabled,
        });
        return publicAgentDefinition(profile);
      }),
    ),

  /** Archive a profile (owner or instance admin). Bindings survive via SetNull. */
  archive: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(({ ctx, input }) =>
      profileTransaction(ctx.db, async (tx) => {
        await assertCanEdit(tx, ctx.session.user.id, input.id);
        const profile = await tx.agentProfile.update({
          where: { id: input.id },
          data: { archivedAt: new Date() },
        });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.archived", {
          profileId: input.id,
        });
        return publicAgentDefinition(profile);
      }),
    ),

  /**
   * Instance admin: smart remove — what the admin UI's "Remove" action calls.
   * Hard-deletes a profile that no workspace has ever bound (the throwaway /
   * mistake case); if any Agent binding still references it, ARCHIVES instead so
   * those bindings aren't orphaned (profile delete is SetNull on the Agent).
   * Archived profiles drop out of the admin list and the bindable catalog.
   */
  remove: instanceAdminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(({ ctx, input }) =>
      profileTransaction(ctx.db, async (tx) => {
        const profile = await tx.agentProfile.findUnique({
          where: { id: input.id },
          select: { id: true, name: true, _count: { select: { bindings: true } } },
        });
        if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
        const boundAgents = profile._count.bindings;
        if (boundAgents > 0) {
          await tx.agentProfile.update({
            where: { id: profile.id },
            data: { archivedAt: new Date() },
          });
          await auditAgentProfile(tx, auditActor(ctx), "agent.profile.archived", {
            profileId: profile.id,
            boundAgents,
          });
          return { action: "archived" as const, name: profile.name, boundAgents };
        }
        await tx.agentProfile.delete({ where: { id: profile.id } });
        await auditAgentProfile(tx, auditActor(ctx), "agent.profile.deleted", {
          profileId: profile.id,
        });
        return { action: "deleted" as const, name: profile.name, boundAgents: 0 };
      }),
    ),
});
