import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ActionRequestStatus, NotificationSeverity } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  createActionRequest,
  transitionActionRequest,
} from "@/server/services/action-request-service";

export const actionRequestRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ActionRequestStatus).optional(),
          assignedUserId: z.string().cuid().optional(),
          assignedAgentId: z.string().cuid().optional(),
          issueId: z.string().cuid().optional(),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.actionRequest.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: input.status,
          assignedUserId: input.assignedUserId,
          assignedAgentId: input.assignedAgentId,
          issueId: input.issueId,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
      return { items: rows };
    }),

  /** Open requests assigned to the calling user. Powers the inbox surface. */
  listMine: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ActionRequestStatus).default(ActionRequestStatus.OPEN),
          limit: z.number().int().positive().max(100).default(50),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      const rows = await ctx.db.actionRequest.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          assignedUserId: userId,
          status: input.status,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
      });
      return { items: rows };
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.actionRequest.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
      }
      return row;
    }),

  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(300),
        body: z.string().max(10_000).nullable().optional(),
        severity: z.nativeEnum(NotificationSeverity).optional(),
        assignedUserId: z.string().cuid().nullable().optional(),
        assignedAgentId: z.string().cuid().nullable().optional(),
        sourceType: z.string().max(40).nullable().optional(),
        sourceId: z.string().max(40).nullable().optional(),
        issueId: z.string().cuid().nullable().optional(),
        dueAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await createActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        title: input.title,
        body: input.body ?? null,
        severity: input.severity,
        assignedUserId: input.assignedUserId ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        issueId: input.issueId ?? null,
        dueAt: input.dueAt ?? null,
      });
      return result;
    }),

  resolve: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        resolution: z.string().max(10_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await transitionActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        requestId: input.id,
        status: ActionRequestStatus.RESOLVED,
        resolution: input.resolution ?? null,
      });
      return { ok: true };
    }),

  dismiss: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await transitionActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        requestId: input.id,
        status: ActionRequestStatus.DISMISSED,
      });
      return { ok: true };
    }),

  snooze: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await transitionActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session?.user?.id ?? null,
        requestId: input.id,
        status: ActionRequestStatus.SNOOZED,
      });
      return { ok: true };
    }),
});
