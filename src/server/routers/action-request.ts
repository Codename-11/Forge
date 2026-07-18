import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ActionRequestKind, ActionRequestStatus, NotificationSeverity } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { agentIdSchema } from "@/server/validators";
import {
  acceptActionRequest,
  closeActionRequestVoting,
  createActionRequest,
  deliveryConflictDecisionSchema,
  declineActionRequest,
  getActionRequestResults,
  resolveDeliveryConnectionConflict,
  transitionActionRequest,
  voteOnActionRequest,
} from "@/server/services/action-request-service";
import { enqueueGitHubResourceReconciliation } from "@/server/services/github/reconciliation-queue";
import { IMPLEMENTATION_LINK_KINDS } from "@/server/services/github/types";

/**
 * Zod-side mirror of `ActionRequestKind` so the router can accept the
 * literal at the API boundary. The service layer re-parses the
 * payload against the right per-kind schema, so this stays a thin
 * shape — no need to discriminated-union it here.
 */
const actionRequestKindSchema = z.nativeEnum(ActionRequestKind);

/**
 * Zod schema for poll options at the API boundary. Mirrors the
 * service-side `actionRequestPollOptionsSchema` but stays loose at
 * the edge — the service re-validates with the strict count + unique
 * checks before persistence.
 */
const pollOptionSchema = z.object({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
});

export const actionRequestRouter = router({
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.nativeEnum(ActionRequestStatus).optional(),
          assignedUserId: z.string().cuid().optional(),
          assignedAgentId: agentIdSchema.optional(),
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

  refreshCompletionEvidence: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const request = await ctx.db.actionRequest.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          status: ActionRequestStatus.OPEN,
          sourceType: "completion-candidate",
          issueId: { not: null },
        },
        select: {
          issue: {
            select: {
              externalLinks: {
                where: {
                  kind: { in: [...IMPLEMENTATION_LINK_KINDS] },
                  externalResource: { provider: "GITHUB", resourceType: "PULL_REQUEST" },
                },
                select: { externalResourceId: true },
              },
            },
          },
        },
      });
      if (!request) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Open completion recommendation not found.",
        });
      }
      const resourceIds = [
        ...new Set(request.issue?.externalLinks.map((link) => link.externalResourceId) ?? []),
      ];
      await Promise.all(
        resourceIds.map((externalResourceId) =>
          enqueueGitHubResourceReconciliation({
            workspaceId: ctx.workspaceId,
            externalResourceId,
            actorId: ctx.session?.user?.id ?? null,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          }),
        ),
      );
      return { queued: resourceIds.length };
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

  /**
   * Look up the ActionRequest attached to an execution plan (if any).
   * The backend's `plans.requestApproval` opens an ActionRequest with
   * `sourceType="execution-plan"` + `sourceId=planId`; the plan cockpit
   * renders the bound row inline so Accept fires the proper activation
   * path (DRAFT→RUNNING + goal→ACTIVE + crew kickoff) rather than a
   * direct status flip. Returns `null` when no row is bound (e.g. a plan
   * created before this flow), so the caller can fall back gracefully.
   */
  forPlan: workspaceProcedure
    .input(z.object({ planId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.actionRequest.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          sourceType: "execution-plan",
          sourceId: input.planId,
        },
        // Newest first so an open request wins over a stale resolved one.
        orderBy: { createdAt: "desc" },
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
        /**
         * Optional poll options. When provided, the renderer treats
         * this request as a multi-vote poll — operators vote via
         * `actionRequest.vote` and the requester closes voting via
         * `actionRequest.closeVoting` to surface the winning option.
         */
        options: z.array(pollOptionSchema).min(2).max(8).optional(),
        assignedUserId: z.string().cuid().nullable().optional(),
        assignedAgentId: agentIdSchema.nullable().optional(),
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
        options: input.options ?? null,
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
   * Cast or update the caller's vote on a poll-style ActionRequest.
   * Each user gets one vote per request; calling this with a
   * different `optionKey` overwrites the previous pick until the
   * requester closes voting.
   */
  vote: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        optionKey: z.string().trim().min(1).max(80),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      return voteOnActionRequest(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: userId,
        requestId: input.id,
        optionKey: input.optionKey,
      });
    }),

  /**
   * Return live vote tallies for a poll-style ActionRequest. Includes
   * the caller's current pick (if any) so the UI can highlight it.
   * `winningOptionKey` is populated only after voting closes.
   */
  results: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      return getActionRequestResults(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: userId,
        requestId: input.id,
      });
    }),

  /**
   * Close voting on a poll. Only the original requester (the user
   * who created the request, or the agent that authored it for an
   * agent-requested poll) can call this. Returns the winning option
   * key — ties are broken by earliest first-vote.
   */
  closeVoting: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      return closeActionRequestVoting(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: userId,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        requestId: input.id,
      });
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

  resolveDeliveryConflict: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        decision: deliveryConflictDecisionSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session?.user?.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "No session user." });
      }
      return resolveDeliveryConnectionConflict(ctx.db, {
        workspaceId: ctx.workspaceId,
        actorId: userId,
        requestId: input.id,
        decision: input.decision,
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
