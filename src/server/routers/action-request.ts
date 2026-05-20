import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ActionRequestKind, ActionRequestStatus, NotificationSeverity } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import {
  acceptActionRequest,
  createActionRequest,
  declineActionRequest,
  transitionActionRequest,
} from "@/server/services/action-request-service";

/**
 * Zod-side mirror of `ActionRequestKind` so the router can accept the
 * literal at the API boundary. The service layer re-parses the
 * payload against the right per-kind schema, so this stays a thin
 * shape — no need to discriminated-union it here.
 */
const actionRequestKindSchema = z.nativeEnum(ActionRequestKind);

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
        include: {
          requestedByUser: { select: { id: true, name: true, image: true, handle: true } },
          requestedByAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          assignedUser: { select: { id: true, name: true, image: true, handle: true } },
          assignedAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          resolvedByUser: { select: { id: true, name: true, image: true, handle: true } },
        },
      });
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Action request not found." });
      }
      return row;
    }),

  /**
   * Look up the ActionRequest attached to a comment (if any). Used by
   * the issue detail timeline to render the `<ActionRequestCard>` above
   * an agent's comment. Returns `null` when no row is bound, so the
   * caller can render unconditionally.
   */
  forComment: workspaceProcedure
    .input(z.object({ commentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.actionRequest.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          sourceType: "comment",
          sourceId: input.commentId,
        },
        include: {
          requestedByUser: { select: { id: true, name: true, image: true, handle: true } },
          requestedByAgent: { select: { id: true, name: true, profileKey: true, avatar: true } },
          resolvedByUser: { select: { id: true, name: true, image: true, handle: true } },
        },
      });
      return row;
    }),

  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1).max(300),
        body: z.string().max(10_000).nullable().optional(),
        severity: z.nativeEnum(NotificationSeverity).optional(),
        kind: actionRequestKindSchema.optional(),
        payload: z.unknown().optional(),
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
        kind: input.kind,
        payload: input.payload,
        assignedUserId: input.assignedUserId ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        issueId: input.issueId ?? null,
        dueAt: input.dueAt ?? null,
      });
      return result;
    }),

  /**
   * Accept the request: run the kind-specific dispatch (transition /
   * setLabels / etc.) and flip status=RESOLVED in the same transaction.
   * Permission-gated to assignee / watcher / OWNER / ADMIN.
   */
  accept: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        resolution: z.string().max(2_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      return acceptActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: userId,
        requestId: input.id,
        resolution: input.resolution ?? null,
      });
    }),

  /**
   * Decline the request: flip status=REJECTED with the operator's
   * reason. Never dispatches the bound action. Same permission gate
   * as `accept`.
   */
  decline: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        reason: z.string().max(2_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      return declineActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: userId,
        requestId: input.id,
        reason: input.reason ?? null,
      });
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
