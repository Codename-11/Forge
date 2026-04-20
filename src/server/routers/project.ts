import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

const cursorSchema = z.string().optional();
const projectKey = z.string().min(2).max(8).regex(/^[A-Z0-9]+$/);

export const projectRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          archived: z.boolean().default(false),
          limit: z.number().min(1).max(500).default(50),
          cursor: cursorSchema,
        })
        .default({ archived: false, limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.project.findMany({
        where: { workspaceId: ctx.workspaceId, archived: input.archived, deletedAt: null },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { issues: true } } },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      return { items: rows, nextCursor };
    }),

  byId: workspaceProcedure.input(z.object({ id: z.string().cuid() })).query(async ({ ctx, input }) => {
    const project = await ctx.db.project.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
    });
    if (!project) throw new TRPCError({ code: "NOT_FOUND" });
    return project;
  }),

  create: workspaceProcedure
    .input(
      z.object({
        key: projectKey,
        name: z.string().min(1).max(120),
        description: z.string().max(4000).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        icon: z.string().max(8).optional(),
        startDate: z.date().optional(),
        targetDate: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: { ...input, workspaceId: ctx.workspaceId, createdById: ctx.session.user.id },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Project",
          entityId: project.id,
          action: "create",
          after: project,
          eventKind: EventKind.PROJECT_CREATED,
          subjectType: "project",
          subjectId: project.id,
          payload: { name: project.name, key: project.key },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return project;
      });
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(4000).nullable().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        icon: z.string().max(8).optional(),
        archived: z.boolean().optional(),
        startDate: z.date().nullable().optional(),
        targetDate: z.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.project.findFirstOrThrow({
          where: { id, workspaceId: ctx.workspaceId },
        });
        const after = await tx.project.update({ where: { id }, data: patch });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Project",
          entityId: id,
          action: "update",
          before,
          after,
          eventKind: EventKind.PROJECT_UPDATED,
          subjectType: "project",
          subjectId: id,
          payload: patch,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return after;
      });
    }),

  archive: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.project.update({
        where: { id: input.id },
        data: { archived: true },
      }),
    ),

  softDelete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const p = await ctx.db.project.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.project.update({
        where: { id: p.id },
        data: { deletedAt: new Date() },
      });
    }),
});
