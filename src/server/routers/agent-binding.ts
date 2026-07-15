import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EngagementMode, EventKind } from "@prisma/client";
import { router, workspaceProcedure, adminProcedure, protectedProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

/**
 * Workspace agent **bindings** — the per-workspace adoption of a global
 * AgentProfile. An `Agent` row IS the binding (it carries per-workspace
 * policy: maxConcurrent, capability overrides, autoDispatchEligible,
 * engagementMode). Reads are workspace-scoped; bind / unbind / policy
 * edits are admin-gated. Profiles are defined globally
 * (`agents.profiles.*`); rules in `dispatchRule.*` may only target a
 * bound agent. Part of the multi-workspace restructure.
 */

export const agentBindingRouter = router({
  /** Profiles available to bind here (owned + instance-shared) and not already bound. */
  catalog: workspaceProcedure.query(async ({ ctx }) => {
    const bound = await ctx.db.agent.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null, profileId: { not: null } },
      select: { profileId: true },
    });
    const boundIds = new Set(bound.map((b) => b.profileId!));
    const profiles = await ctx.db.agentProfile.findMany({
      where: {
        archivedAt: null,
        disabledAt: null,
        // Only approved profiles are bindable. A profile is approved when it
        // wasn't requested (admin-created → requestedById null) or has been
        // approved (approvedAt set). Pending requests are hidden from the catalog.
        AND: [
          { OR: [{ ownerId: ctx.session.user.id }, { instanceShared: true }] },
          { OR: [{ requestedById: null }, { approvedAt: { not: null } }] },
        ],
      },
      orderBy: { createdAt: "asc" },
      include: { runtime: { select: { id: true, name: true, kind: true } } },
    });
    return profiles
      .filter((p) => !boundIds.has(p.id))
      .map((p) => ({ ...p, ownedByMe: p.ownerId === ctx.session.user.id }));
  }),

  /** Agents bound to this workspace, with policy + live-use rollup. */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const agents = await ctx.db.agent.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        profile: {
          select: {
            id: true,
            profileKey: true,
            name: true,
            instanceShared: true,
            disabledAt: true,
            baseCapabilities: true,
            ownerId: true,
          },
        },
        runtime: { select: { id: true, name: true, kind: true } },
        _count: { select: { assignedIssues: true } },
      },
    });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return Promise.all(
      agents.map(async (a) => {
        const [runs24, activeRuns] = await Promise.all([
          ctx.db.agentRun.count({ where: { agentId: a.id, startedAt: { gte: since } } }),
          ctx.db.agentRun.count({ where: { agentId: a.id, status: "ACTIVE" } }),
        ]);
        return { ...a, runs24, activeRuns };
      }),
    );
  }),

  /** Bind a global profile into this workspace, copying its definition into the binding row. */
  bind: adminProcedure
    .input(
      z.object({
        profileId: z.string().cuid(),
        maxConcurrent: z.number().int().min(0).max(50).optional(),
        autoDispatchEligible: z.boolean().optional(),
        engagementMode: z.nativeEnum(EngagementMode).nullish(),
        requireApprovalBeforeStart: z.boolean().optional(),
        capabilities: z.array(z.string().min(1).max(40)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const profile = await ctx.db.agentProfile.findUnique({ where: { id: input.profileId } });
      if (!profile || profile.archivedAt)
        throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      const shareable = profile.ownerId === ctx.session.user.id || profile.instanceShared;
      if (!shareable)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That profile isn't available to this workspace.",
        });
      // Pending (requested-but-unapproved) profiles can't be bound.
      if (profile.requestedById && !profile.approvedAt) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That profile is pending instance-admin approval.",
        });
      }

      // profileKey is unique per (workspaceId). Reuse an archived binding if present.
      const existing = await ctx.db.agent.findUnique({
        where: {
          workspaceId_profileKey: { workspaceId: ctx.workspaceId, profileKey: profile.profileKey },
        },
        select: { id: true, archivedAt: true },
      });
      if (existing && !existing.archivedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That profile is already bound to this workspace.",
        });
      }

      const data = {
        profileId: profile.id,
        name: profile.name,
        profileKey: profile.profileKey,
        description: profile.description,
        avatar: profile.avatar,
        provider: profile.provider,
        runtimeMode: profile.runtimeMode,
        runEngine: profile.runEngine,
        webhookUrl: profile.webhookUrl,
        webhookSecret: profile.webhookSecret,
        runtimeId: profile.runtimeId,
        role: profile.role,
        templateMarkdown: profile.templateMarkdown,
        capabilities: input.capabilities ?? profile.baseCapabilities,
        maxConcurrent: input.maxConcurrent ?? 1,
        autoDispatchEligible: input.autoDispatchEligible ?? true,
        engagementMode: input.engagementMode ?? null,
        requireApprovalBeforeStart: input.requireApprovalBeforeStart ?? false,
      };

      const agent = existing
        ? await ctx.db.agent.update({
            where: { id: existing.id },
            data: { ...data, archivedAt: null },
          })
        : await ctx.db.agent.create({ data: { ...data, workspaceId: ctx.workspaceId } });

      await recordChange(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Agent",
        entityId: agent.id,
        action: "create",
        after: { profileKey: agent.profileKey, profileId: profile.id },
        eventKind: EventKind.AGENT_CREATED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: { profileKey: agent.profileKey, profileId: profile.id, bound: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return agent;
    }),

  /**
   * Mission Control bind action. The caller chooses an explicit workspace,
   * then receives the same workspace-admin and audit guarantees as `bind`.
   */
  bindFromMissionControl: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().cuid(),
        profileId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.session.user.id,
            workspaceId: input.workspaceId,
          },
        },
        select: { role: true },
      });
      if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Workspace admin role required." });
      }

      const [profile, actor] = await Promise.all([
        ctx.db.agentProfile.findUnique({ where: { id: input.profileId } }),
        ctx.db.user.findUnique({
          where: { id: ctx.session.user.id },
          select: { instanceRole: true },
        }),
      ]);
      if (!profile || profile.archivedAt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Profile not found." });
      }
      const available =
        profile.ownerId === ctx.session.user.id ||
        profile.instanceShared ||
        actor?.instanceRole === "INSTANCE_ADMIN";
      if (!available) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That profile isn't available to this workspace.",
        });
      }
      if (profile.requestedById && !profile.approvedAt) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That profile is pending instance-admin approval.",
        });
      }
      if (profile.disabledAt) {
        throw new TRPCError({ code: "FORBIDDEN", message: "That profile is disabled." });
      }

      const existing = await ctx.db.agent.findUnique({
        where: {
          workspaceId_profileKey: {
            workspaceId: input.workspaceId,
            profileKey: profile.profileKey,
          },
        },
        select: { id: true, archivedAt: true },
      });
      if (existing && !existing.archivedAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That profile is already bound to this workspace.",
        });
      }

      const data = {
        profileId: profile.id,
        name: profile.name,
        profileKey: profile.profileKey,
        description: profile.description,
        avatar: profile.avatar,
        provider: profile.provider,
        runtimeMode: profile.runtimeMode,
        runEngine: profile.runEngine,
        webhookUrl: profile.webhookUrl,
        webhookSecret: profile.webhookSecret,
        runtimeId: profile.runtimeId,
        role: profile.role,
        templateMarkdown: profile.templateMarkdown,
        capabilities: profile.baseCapabilities,
        maxConcurrent: 1,
        autoDispatchEligible: true,
        engagementMode: null,
        requireApprovalBeforeStart: false,
      };

      const agent = existing
        ? await ctx.db.agent.update({
            where: { id: existing.id },
            data: { ...data, archivedAt: null },
          })
        : await ctx.db.agent.create({
            data: { ...data, workspaceId: input.workspaceId },
          });

      await recordChange(ctx.db, {
        workspaceId: input.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: null,
        entity: "Agent",
        entityId: agent.id,
        action: "create",
        after: { profileKey: agent.profileKey, profileId: profile.id },
        eventKind: EventKind.AGENT_CREATED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: { profileKey: agent.profileKey, profileId: profile.id, bound: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return agent;
    }),

  /** Per-binding policy edit. */
  setPolicy: adminProcedure
    .input(
      z.object({
        agentId: z.string().cuid(),
        maxConcurrent: z.number().int().min(0).max(50).optional(),
        autoDispatchEligible: z.boolean().optional(),
        engagementMode: z.nativeEnum(EngagementMode).nullish(),
        requireApprovalBeforeStart: z.boolean().optional(),
        capabilities: z.array(z.string().min(1).max(40)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      const { agentId, ...patch } = input;
      const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      return ctx.db.agent.update({ where: { id: agentId }, data });
    }),

  /** Unbind (archive) an agent binding. Runs / chats / history are preserved. */
  unbind: adminProcedure
    .input(z.object({ agentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: ctx.workspaceId },
        select: { id: true, profileKey: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      const updated = await ctx.db.agent.update({
        where: { id: agent.id },
        data: { archivedAt: new Date() },
      });
      await recordChange(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Agent",
        entityId: agent.id,
        action: "delete",
        before: { profileKey: agent.profileKey },
        eventKind: EventKind.AGENT_DELETED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: { profileKey: agent.profileKey, unbound: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    }),

  /** Mission Control unbind action, explicitly scoped to a managed workspace. */
  unbindFromMissionControl: protectedProcedure
    .input(z.object({ workspaceId: z.string().cuid(), agentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.session.user.id,
            workspaceId: input.workspaceId,
          },
        },
        select: { role: true },
      });
      if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Workspace admin role required." });
      }
      const agent = await ctx.db.agent.findFirst({
        where: { id: input.agentId, workspaceId: input.workspaceId, archivedAt: null },
        select: { id: true, profileKey: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Binding not found." });

      const updated = await ctx.db.agent.update({
        where: { id: agent.id },
        data: { archivedAt: new Date() },
      });
      await recordChange(ctx.db, {
        workspaceId: input.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: null,
        entity: "Agent",
        entityId: agent.id,
        action: "delete",
        before: { profileKey: agent.profileKey },
        eventKind: EventKind.AGENT_DELETED,
        subjectType: "agent",
        subjectId: agent.id,
        payload: { profileKey: agent.profileKey, unbound: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    }),
});
