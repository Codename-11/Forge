import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, Priority, WorkItemKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

const cursorSchema = z.string().optional();

const filterSchema = z.object({
  projectId: z.string().cuid().optional(),
  statusId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  priority: z.nativeEnum(Priority).optional(),
  query: z.string().max(200).optional(),
  includeDone: z.boolean().default(true),
  limit: z.number().min(1).max(100).default(50),
  cursor: cursorSchema,
});

export const issueRouter = router({
  list: workspaceProcedure
    .input(filterSchema.default({ includeDone: true, limit: 50 }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.statusId ? { statusId: input.statusId } : {}),
          ...(input.assigneeId ? { assignees: { some: { userId: input.assigneeId } } } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.query
            ? {
                OR: [
                  { title: { contains: input.query, mode: "insensitive" } },
                  { description: { contains: input.query, mode: "insensitive" } },
                ],
              }
            : {}),
          ...(input.includeDone
            ? {}
            : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
        },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        include: {
          status: true,
          project: { select: { id: true, key: true, name: true, color: true, icon: true } },
          assignees: { include: { user: { select: { id: true, name: true, image: true } } } },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
        },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      return { items: rows, nextCursor };
    }),

  byId: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
        include: {
          status: true,
          project: true,
          author: { select: { id: true, name: true, image: true } },
          assignees: { include: { user: { select: { id: true, name: true, image: true } } } },
          labels: { include: { label: true } },
          comments: {
            orderBy: { createdAt: "asc" },
            include: { author: { select: { id: true, name: true, image: true } } },
          },
          attachments: true,
          children: {
            select: { id: true, number: true, title: true, statusId: true },
            orderBy: { number: "asc" },
          },
          parent: { select: { id: true, number: true, title: true } },
        },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      return issue;
    }),

  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(50_000).optional(),
        projectId: z.string().cuid().optional(),
        parentId: z.string().cuid().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.nativeEnum(Priority).default(Priority.NONE),
        kind: z.nativeEnum(WorkItemKind).default(WorkItemKind.ISSUE),
        assigneeIds: z.array(z.string().cuid()).default([]),
        labelIds: z.array(z.string().cuid()).default([]),
        dueDate: z.date().optional(),
        estimate: z.number().min(0).optional(),
        slaMinutes: z.number().int().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const status = input.statusId
          ? await tx.status.findFirstOrThrow({
              where: { id: input.statusId, workspaceId: ctx.workspaceId },
            })
          : await tx.status.findFirstOrThrow({
              where: { workspaceId: ctx.workspaceId, isDefault: true },
            });

        const last = await tx.issue.findFirst({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;

        const issue = await tx.issue.create({
          data: {
            workspaceId: ctx.workspaceId,
            number,
            kind: input.kind,
            title: input.title,
            description: input.description,
            projectId: input.projectId,
            parentId: input.parentId,
            statusId: status.id,
            priority: input.priority,
            authorId: ctx.session.user.id,
            dueDate: input.dueDate,
            estimate: input.estimate,
            slaMinutes: input.slaMinutes,
            assignees: {
              create: input.assigneeIds.map((userId) => ({ userId })),
            },
            labels: {
              create: input.labelIds.map((labelId) => ({ labelId })),
            },
          },
          include: { status: true, assignees: true, labels: true },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: issue.id,
          action: "create",
          after: issue,
          eventKind: EventKind.ISSUE_CREATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: { number: issue.number, title: issue.title },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return issue;
      });
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        title: z.string().min(1).max(300).optional(),
        description: z.string().max(50_000).nullable().optional(),
        statusId: z.string().cuid().optional(),
        priority: z.nativeEnum(Priority).optional(),
        projectId: z.string().cuid().nullable().optional(),
        dueDate: z.date().nullable().optional(),
        estimate: z.number().min(0).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: { id, workspaceId: ctx.workspaceId },
          include: { status: true },
        });

        // Mark lifecycle timestamps based on status category transitions.
        let extra: { startedAt?: Date; completedAt?: Date | null; canceledAt?: Date | null } = {};
        if (patch.statusId && patch.statusId !== before.statusId) {
          const next = await tx.status.findFirstOrThrow({ where: { id: patch.statusId } });
          if (next.category === "IN_PROGRESS" && !before.startedAt) extra.startedAt = new Date();
          if (next.category === "DONE") extra.completedAt = new Date();
          if (next.category === "CANCELED") extra.canceledAt = new Date();
          if (next.category !== "DONE") extra.completedAt = null;
          if (next.category !== "CANCELED") extra.canceledAt = null;
        }

        const after = await tx.issue.update({
          where: { id },
          data: { ...patch, ...extra },
          include: { status: true },
        });

        const kind =
          patch.statusId && patch.statusId !== before.statusId
            ? EventKind.ISSUE_STATUS_CHANGED
            : patch.priority && patch.priority !== before.priority
              ? EventKind.ISSUE_PRIORITY_CHANGED
              : EventKind.ISSUE_UPDATED;

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: id,
          action: "update",
          before,
          after,
          eventKind: kind,
          subjectType: "issue",
          subjectId: id,
          payload: patch,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return after;
      });
    }),

  assign: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), userIds: z.array(z.string().cuid()) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        await tx.issueAssignee.deleteMany({ where: { issueId: input.id } });
        if (input.userIds.length) {
          await tx.issueAssignee.createMany({
            data: input.userIds.map((userId) => ({ issueId: input.id, userId })),
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: input.id,
          action: "assign",
          after: { assigneeIds: input.userIds },
          eventKind: EventKind.ISSUE_ASSIGNED,
          subjectType: "issue",
          subjectId: input.id,
          payload: { assigneeIds: input.userIds },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return tx.issue.findUniqueOrThrow({
          where: { id: input.id },
          include: { assignees: { include: { user: true } } },
        });
      });
    }),

  softDelete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.issue.update({ where: { id: input.id }, data: { deletedAt: new Date() } }),
    ),

  bulkStatus: workspaceProcedure
    .input(z.object({ ids: z.array(z.string().cuid()).max(200), statusId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.issue.updateMany({
        where: { id: { in: input.ids }, workspaceId: ctx.workspaceId },
        data: { statusId: input.statusId },
      }),
    ),

  setQueued: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), queued: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.issue.update({
        where: { id: issue.id },
        data: {
          queued: input.queued,
          // Releasing from queue while claimed leaves the claim intact (agent still owns it).
          ...(!input.queued && issue.claimedAt == null
            ? { claimedAt: null, claimedById: null, claimExpiresAt: null }
            : {}),
        },
      });
    }),

  release: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const issue = await ctx.db.issue.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      return ctx.db.issue.update({
        where: { id: issue.id },
        data: { claimedAt: null, claimedById: null, claimExpiresAt: null },
      });
    }),

  queue: workspaceProcedure
    .input(
      z.object({
        includeClaimed: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          ...(input.includeClaimed ? {} : { claimedAt: null }),
        },
        orderBy: [{ claimedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
        take: input.limit,
        include: {
          status: true,
          project: { select: { id: true, name: true, key: true, color: true } },
          claimedBy: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
    ),
});
