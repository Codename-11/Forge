import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Role } from "@prisma/client";
import { router, protectedProcedure, workspaceProcedure, adminProcedure } from "@/server/trpc";

const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.");

const keySchema = z
  .string()
  .min(2)
  .max(6)
  .regex(/^[A-Z]+$/, "Key must be uppercase letters.");

export const workspaceRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.workspace.findMany({
      where: {
        deletedAt: null,
        memberships: { some: { userId: ctx.session.user.id } },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        key: true,
        avatarUrl: true,
        memberships: {
          where: { userId: ctx.session.user.id },
          select: { role: true },
          take: 1,
        },
      },
    });
  }),

  // Minimal mutation used by the workspace switcher + shell layout to
  // remember the last-visited workspace across sign-ins. Agent C will
  // extend the workspace router with update/archive/delete; this safe
  // one-liner stays in Agent E's lane per the migration plan.
  setLastWorkspace: protectedProcedure
    .input(z.object({ workspaceId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: ctx.session.user.id,
            workspaceId: input.workspaceId,
          },
        },
      });
      if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { lastWorkspaceId: input.workspaceId },
        select: { id: true, lastWorkspaceId: true },
      });
    }),

  current: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      include: {
        statuses: { orderBy: { position: "asc" } },
        _count: { select: { projects: true, issues: true, memberships: true } },
      },
    });
  }),

  create: protectedProcedure
    .input(
      z.object({
        slug: slugSchema,
        name: z.string().min(1).max(80),
        key: keySchema,
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
        timeTrackingEnabled: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.workspace.findFirst({
        where: { OR: [{ slug: input.slug }, { key: input.key }] },
      });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "Slug or key in use." });

      // NOTE: Agent C will extend this with bucket seeding + richer
      // onboarding (default statuses come from a seed helper later).
      return ctx.db.workspace.create({
        data: {
          slug: input.slug,
          name: input.name,
          key: input.key,
          cycleLengthDays: input.cycleLengthDays ?? 7,
          timeTrackingEnabled: input.timeTrackingEnabled ?? false,
          memberships: { create: { userId: ctx.session.user.id, role: Role.OWNER } },
          statuses: {
            create: [
              { name: "Backlog", category: "BACKLOG", color: "#78716c", position: 0, isDefault: true },
              { name: "Todo", category: "TODO", color: "#a8a29e", position: 1 },
              { name: "In Progress", category: "IN_PROGRESS", color: "#d97706", position: 2 },
              { name: "In Review", category: "IN_REVIEW", color: "#ca8a04", position: 3 },
              { name: "Done", category: "DONE", color: "#65a30d", position: 4 },
              { name: "Canceled", category: "CANCELED", color: "#57534e", position: 5 },
            ],
          },
        },
      });
    }),

  // Mutations below are the minimum surface required by the workspace
  // settings UI shipped in Phase 2E. Agent C owns the fuller workspace
  // router overhaul — keep any extensions here tight and additive.
  update: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80).optional(),
        avatarUrl: z.string().url().max(512).nullable().optional(),
        cycleLengthDays: z.number().int().min(1).max(90).optional(),
        cycleCooldownDays: z.number().int().min(0).max(30).optional(),
        timeTrackingEnabled: z.boolean().optional(),
        attachmentQuotaMb: z.number().int().min(0).max(1_024_000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.workspace.update({
        where: { id: ctx.workspaceId },
        data: input,
      });
    }),

  archive: adminProcedure.mutation(async ({ ctx }) => {
    if (ctx.membership.role !== Role.OWNER) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can archive a workspace." });
    }
    return ctx.db.workspace.update({
      where: { id: ctx.workspaceId },
      data: { deletedAt: new Date() },
    });
  }),

  delete: adminProcedure
    .input(z.object({ confirmName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== Role.OWNER) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can delete a workspace." });
      }
      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { id: true, name: true },
      });
      if (input.confirmName !== ws.name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirmation name does not match workspace name.",
        });
      }
      return ctx.db.workspace.delete({ where: { id: ctx.workspaceId } });
    }),

  me: workspaceProcedure.query(async ({ ctx }) => {
    const membership = await ctx.db.membership.findUniqueOrThrow({
      where: {
        userId_workspaceId: { userId: ctx.session.user.id, workspaceId: ctx.workspaceId },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            handle: true,
            timezone: true,
            locale: true,
            timeFormat: true,
            theme: true,
          },
        },
      },
    });
    return membership;
  }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80).optional(),
        handle: z
          .string()
          .min(2)
          .max(32)
          .regex(/^[a-z0-9_-]+$/i)
          .optional(),
        timezone: z.string().max(80).nullable().optional(),
        locale: z.string().max(16).nullable().optional(),
        timeFormat: z.enum(["12h", "24h"]).nullable().optional(),
        theme: z.enum(["light", "dark", "system"]).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: input,
        select: {
          id: true,
          name: true,
          email: true,
          handle: true,
          timezone: true,
          locale: true,
          timeFormat: true,
          theme: true,
        },
      });
    }),

  members: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.membership.findMany({
      where: { workspaceId: ctx.workspaceId },
      include: {
        user: { select: { id: true, name: true, email: true, image: true, handle: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }),

  invite: adminProcedure
    .input(z.object({ email: z.string().email(), role: z.nativeEnum(Role) }))
    .mutation(async ({ ctx, input }) => {
      // Invites are a separate lifecycle in production — for now, attach by
      // upserting user + membership directly. Swap for email invite flow later.
      const user = await ctx.db.user.upsert({
        where: { email: input.email },
        update: {},
        create: { email: input.email },
      });
      return ctx.db.membership.upsert({
        where: { userId_workspaceId: { userId: user.id, workspaceId: ctx.workspaceId } },
        update: { role: input.role },
        create: { userId: user.id, workspaceId: ctx.workspaceId, role: input.role },
      });
    }),

  updateMember: adminProcedure
    .input(z.object({ membershipId: z.string().cuid(), role: z.nativeEnum(Role) }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.membership.findFirstOrThrow({
        where: { id: input.membershipId, workspaceId: ctx.workspaceId },
      });
      if (target.userId === ctx.session.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Change your own role via transfer." });
      }
      // Can't demote the last owner.
      if (target.role === Role.OWNER && input.role !== Role.OWNER) {
        const owners = await ctx.db.membership.count({
          where: { workspaceId: ctx.workspaceId, role: Role.OWNER },
        });
        if (owners <= 1)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Promote another owner first." });
      }
      return ctx.db.membership.update({
        where: { id: input.membershipId },
        data: { role: input.role },
      });
    }),

  removeMember: adminProcedure
    .input(z.object({ membershipId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.membership.findFirstOrThrow({
        where: { id: input.membershipId, workspaceId: ctx.workspaceId },
      });
      if (target.userId === ctx.session.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You can't remove yourself." });
      }
      if (target.role === Role.OWNER) {
        const owners = await ctx.db.membership.count({
          where: { workspaceId: ctx.workspaceId, role: Role.OWNER },
        });
        if (owners <= 1)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Can't remove the last owner." });
      }
      return ctx.db.membership.delete({ where: { id: input.membershipId } });
    }),
});
