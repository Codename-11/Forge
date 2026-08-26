import { EventKind, ProjectAccessRole } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { recordChange } from "@/server/audit";
import { router, workspaceProcedure } from "@/server/trpc";
import { assertProjectForViewer } from "@/server/services/project-access";

const projectInput = z.object({ projectId: z.string().cuid() });

export const projectAccessRouter = router({
  candidates: workspaceProcedure.input(projectInput).query(async ({ ctx, input }) => {
    await assertProjectForViewer(ctx.db, ctx, input.projectId, "MANAGE");
    const memberships = await ctx.db.membership.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        role: true,
        user: { select: { id: true, name: true, email: true, image: true, handle: true } },
        projectAccesses: {
          where: { projectId: input.projectId },
          select: { role: true },
          take: 1,
        },
      },
    });
    return memberships.map(({ projectAccesses, ...membership }) => {
      const inheritedAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
      return {
        membershipId: membership.id,
        workspaceRole: membership.role,
        user: membership.user,
        projectRole: projectAccesses[0]?.role ?? null,
        inheritedAdmin,
        mutable: !inheritedAdmin,
      };
    });
  }),

  list: workspaceProcedure.input(projectInput).query(async ({ ctx, input }) => {
    await assertProjectForViewer(ctx.db, ctx, input.projectId, "MANAGE");
    return ctx.db.projectAccess.findMany({
      where: { workspaceId: ctx.workspaceId, projectId: input.projectId },
      orderBy: [{ role: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        role: true,
        createdAt: true,
        updatedAt: true,
        membership: {
          select: {
            id: true,
            role: true,
            user: { select: { id: true, name: true, email: true, image: true, handle: true } },
          },
        },
        grantedBy: { select: { id: true, name: true, email: true } },
      },
    });
  }),

  set: workspaceProcedure
    .input(
      projectInput.extend({
        membershipId: z.string().cuid(),
        role: z.nativeEnum(ProjectAccessRole),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertProjectForViewer(ctx.db, ctx, input.projectId, "MANAGE");
      return ctx.db.$transaction(async (tx) => {
        const membership = await tx.membership.findFirst({
          where: { id: input.membershipId, workspaceId: ctx.workspaceId },
          select: { id: true, userId: true, role: true },
        });
        if (!membership) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Workspace member not found." });
        }
        if (membership.role === "OWNER" || membership.role === "ADMIN") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Workspace administrators already have full project access.",
          });
        }
        const before = await tx.projectAccess.findUnique({
          where: {
            projectId_membershipId: {
              projectId: input.projectId,
              membershipId: input.membershipId,
            },
          },
        });
        const grant = await tx.projectAccess.upsert({
          where: {
            projectId_membershipId: {
              projectId: input.projectId,
              membershipId: input.membershipId,
            },
          },
          create: {
            workspaceId: ctx.workspaceId,
            projectId: input.projectId,
            membershipId: input.membershipId,
            role: input.role,
            grantedById: ctx.session.user.id,
          },
          update: { role: input.role, grantedById: ctx.session.user.id },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "ProjectAccess",
          entityId: grant.id,
          action: before ? "update" : "create",
          before: before ? { membershipId: before.membershipId, role: before.role } : undefined,
          after: { membershipId: grant.membershipId, role: grant.role },
          eventKind: EventKind.PROJECT_ACCESS_CHANGED,
          subjectType: "project",
          subjectId: input.projectId,
          payload: {
            action: before ? "updated" : "granted",
            userId: membership.userId,
            role: grant.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return grant;
      });
    }),

  remove: workspaceProcedure
    .input(projectInput.extend({ membershipId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertProjectForViewer(ctx.db, ctx, input.projectId, "MANAGE");
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.projectAccess.findFirst({
          where: {
            workspaceId: ctx.workspaceId,
            projectId: input.projectId,
            membershipId: input.membershipId,
          },
          include: { membership: { select: { userId: true } } },
        });
        if (!before)
          throw new TRPCError({ code: "NOT_FOUND", message: "Project grant not found." });
        await tx.projectAccess.delete({ where: { id: before.id } });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "ProjectAccess",
          entityId: before.id,
          action: "delete",
          before: { membershipId: before.membershipId, role: before.role },
          eventKind: EventKind.PROJECT_ACCESS_CHANGED,
          subjectType: "project",
          subjectId: input.projectId,
          payload: { action: "revoked", userId: before.membership.userId, role: before.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { ok: true };
      });
    }),
});
