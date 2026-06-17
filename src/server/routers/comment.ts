import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import {
  ActionRequestKind,
  CommentKind,
  ConfidenceLevel,
  EngagementMode,
  EventKind,
  NotificationSeverity,
} from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { agentIdSchema } from "@/server/validators";
import { extractMentions } from "@/server/services/mentions";
import { openOrTouchRun, appendRunEvent } from "@/server/services/agent-run";
import { recordManualDispatchReason } from "@/server/services/dispatcher";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import {
  autoWatchActor,
  autoWatchAgent,
  autoWatchUser,
  setIssueAgentWakeTarget,
} from "@/server/services/issue-watchers";
import { createActionRequest } from "@/server/services/action-request-service";
import { resolveAgentRequests, type ParsedAgentRequest } from "@/lib/agent-request-parser";

const STATUS_REVISION_CAP = 50;
/**
 * Cap on BODY-comment revision rows. STATUS comments keep 50 entries
 * (chatty agents); BODY comments are human-edited and expected to
 * change less often, so 20 is plenty. Oldest is dropped first when
 * the array exceeds the cap.
 */
export const BODY_REVISION_CAP = 20;

/**
 * Cap on attached quick-reply chips. The composer renders these in a
 * single row beneath the comment body, so 4 keeps the row readable
 * even on narrow viewports. Each string is capped at 80 chars so the
 * chip itself doesn't wrap.
 */
export const QUICK_REPLY_MAX_COUNT = 4;
export const QUICK_REPLY_MAX_LENGTH = 80;
export const suggestedRepliesSchema = z
  .array(z.string().trim().min(1).max(QUICK_REPLY_MAX_LENGTH))
  .max(QUICK_REPLY_MAX_COUNT)
  .optional();

/**
 * Optional ActionRequest bundle attached to a `comments.create` call.
 * Agents use this to post a comment + its recommendation card in one
 * round-trip: the request row is created inside the same transaction
 * with `sourceType="comment"` + `sourceId=<commentId>` so the issue
 * detail page's `actionRequest.forComment` lookup pulls the matching
 * row.
 */
export const inlineActionRequestSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(10_000).nullable().optional(),
  severity: z.nativeEnum(NotificationSeverity).optional(),
  kind: z.nativeEnum(ActionRequestKind).default(ActionRequestKind.FREE_FORM),
  payload: z.unknown().optional(),
  /**
   * Optional poll options. When provided alongside an inline
   * ActionRequest, the bound request renders as a multi-vote poll
   * — agents use this to post "here are three approaches, pick
   * one" cards in a single round-trip with the explanatory comment.
   */
  options: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(80),
        label: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2_000).optional(),
      }),
    )
    .min(2)
    .max(8)
    .optional(),
  assignedUserId: z.string().cuid().nullable().optional(),
  assignedAgentId: agentIdSchema.nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export const commentRouter = router({
  create: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        body: z.string().min(1).max(50_000),
        /**
         * Optional quick-reply chip strings the operator can click to
         * pre-fill the composer. Agent-only by convention (human-authored
         * comments will accept this but the renderer hides chips when the
         * authoring side is a human).
         */
        suggestedReplies: suggestedRepliesSchema,
        /**
         * Optional agent confidence flag (LOW / MEDIUM / HIGH).
         * Only rendered as a chip on agent-authored comments; humans
         * can pass it through (the column accepts it) but the UI
         * suppresses the chip for human authors. Defaults to null —
         * unflagged comments render without a chip.
         */
        confidence: z.nativeEnum(ConfidenceLevel).nullable().optional(),
        /**
         * Optional ActionRequest bundle. When set, a matching row is
         * persisted inside the same transaction and bound to the new
         * comment via sourceType/sourceId so the `<ActionRequestCard>`
         * component picks it up.
         */
        actionRequest: inlineActionRequestSchema.optional(),
        /**
         * Explicit structured agent requests. Supplied by the composer
         * chips; when empty the server falls back to parsing `@agent /mode`
         * tokens from the body text.
         */
        agentRequests: z
          .array(
            z.object({
              profileKey: z.string().min(1).max(40),
              mode: z.nativeEnum(EngagementMode).default(EngagementMode.DISCUSS),
              assignIssue: z.boolean().optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.$transaction(async (tx) => {
        const authoringAgentId = ctx.apiKey?.linkedAgentId ?? null;

        const explicitAgentRequests: ParsedAgentRequest[] =
          input.agentRequests?.map((r) => ({
            profileKey: r.profileKey.trim().replace(/^@+/, "").toLowerCase(),
            mode: r.mode,
            assignIssue: r.assignIssue === true,
          })) ?? [];

        // Resolve explicit agent requests (from composer chips) or parse
        // from body text. Cross-reference profileKey to actual agent ids.
        // Bare @agent becomes a DISCUSS request; typed @agent /review and
        // @agent:execute are parser sugar over the same structured payload.
        const agentRequests: Array<{
          agentId: string;
          profileKey: string;
          mode: EngagementMode;
          assignIssue?: boolean;
        }> = [];
        const requestedAgentRequests = resolveAgentRequests(explicitAgentRequests, input.body);
        if (requestedAgentRequests.length > 0) {
          const keys = requestedAgentRequests.map((r) => r.profileKey);
          const agents = await tx.agent.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              profileKey: { in: keys },
              archivedAt: null,
            },
            select: { id: true, profileKey: true },
          });
          const byKey = new Map(agents.map((a) => [a.profileKey.toLowerCase(), a]));
          const seen = new Set<string>();
          for (const req of requestedAgentRequests) {
            const found = byKey.get(req.profileKey.toLowerCase());
            if (found && !seen.has(found.id)) {
              seen.add(found.id);
              agentRequests.push({
                agentId: found.id,
                profileKey: found.profileKey,
                mode: req.mode,
                assignIssue: req.assignIssue,
              });
            }
          }
        }

        const agentRequestsJson = agentRequests.map((r) => ({
          agentId: r.agentId,
          profileKey: r.profileKey,
          mode: r.mode,
          assignIssue: r.assignIssue === true,
        }));

        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            authorId: ctx.session.user.id,
            body: input.body,
            authoringAgentId,
            suggestedReplies: input.suggestedReplies ?? [],
            confidence: input.confidence ?? null,
            agentRequests: agentRequestsJson as Prisma.InputJsonValue,
          },
          include: {
            author: { select: { id: true, name: true, image: true } },
            authoringAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
          },
        });

        // Auto-watch the commenter (user OR agent). Commenting on a
        // thread = wanting to hear about replies. Sticky — they keep
        // watching until they manually unwatch.
        await autoWatchActor(tx, {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          userId: ctx.session.user.id,
          callerAgentId: authoringAgentId,
        });

        // Resolve @-tokens against BOTH Agent.profileKey AND User.handle.
        // The same token regex matches either (the namespace overlap is
        // accepted by design — agents and humans share `@<name>`).
        // Workspace membership gates the user side so a stray @-mention
        // of a workspace-foreign account doesn't subscribe them.
        const tokens = extractMentions(input.body);
        const mentionedAgents: Array<{ agentId: string; profileKey: string }> = [];
        const mentionedUsers: Array<{ userId: string; handle: string }> = [];
        if (tokens.length) {
          const [agentMatches, userMatches] = await Promise.all([
            tx.agent.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                profileKey: { in: tokens },
                archivedAt: null,
              },
              select: { id: true, profileKey: true },
            }),
            tx.user.findMany({
              where: {
                handle: { in: tokens },
                memberships: { some: { workspaceId: ctx.workspaceId } },
              },
              select: { id: true, handle: true },
            }),
          ]);
          for (const a of agentMatches) {
            mentionedAgents.push({ agentId: a.id, profileKey: a.profileKey });
          }
          for (const u of userMatches) {
            // `handle` is `String?` on User but we filtered on `in: tokens`
            // so the matched rows always carry a non-null handle.
            if (u.handle) {
              mentionedUsers.push({ userId: u.id, handle: u.handle });
            }
          }
        }

        const issue = await tx.issue.findFirstOrThrow({
          where: { id: input.issueId, workspaceId: ctx.workspaceId },
          select: {
            id: true,
            number: true,
            title: true,
            assignedAgentId: true,
            workspace: { select: { key: true } },
          },
        });
        const issuePrefix = `${issue.workspace.key}-${issue.number}`;

        // Treat structured Agent Requests as explicit mentions too. This
        // keeps watcher rows, COMMENT_CREATED fan-out, and opened AgentRuns
        // tied to one canonical event even if a client submitted only the
        // structured request payload.
        const mentionedAgentById = new Map(mentionedAgents.map((m) => [m.agentId, m]));
        for (const r of agentRequests) {
          if (!mentionedAgentById.has(r.agentId)) {
            const mention = { agentId: r.agentId, profileKey: r.profileKey };
            mentionedAgentById.set(r.agentId, mention);
            mentionedAgents.push(mention);
          }
        }

        // Subscribe mentioned agents + users to the issue so subsequent
        // events route to them via the watcher fan-out (humans) or the
        // per-agent shim (agents). Branch (c) in audit.ts already
        // dispatches an immediate webhook for mentioned agents — the
        // watcher row is for future events.
        for (const m of mentionedAgents) {
          await autoWatchAgent(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId: m.agentId,
          });
        }
        for (const m of mentionedUsers) {
          await autoWatchUser(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            userId: m.userId,
          });
        }

        const executeAssignment = agentRequests.find(
          (r) => r.mode === EngagementMode.EXECUTE && r.assignIssue === true,
        );
        if (executeAssignment && issue.assignedAgentId !== executeAssignment.agentId) {
          await tx.issue.update({
            where: { id: input.issueId },
            data: { assignedAgentId: executeAssignment.agentId },
          });
          const reasonBlob = await recordManualDispatchReason(tx, {
            issueId: input.issueId,
            agentProfileKey: executeAssignment.profileKey,
            actorId: ctx.session.user.id,
          });
          await setIssueAgentWakeTarget(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId: executeAssignment.agentId,
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: authoringAgentId,
            entity: "Issue",
            entityId: input.issueId,
            action: "assign-agent-request",
            after: { assignedAgentId: executeAssignment.agentId },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: input.issueId,
            payload: {
              agentId: executeAssignment.agentId,
              previousAgentId: issue.assignedAgentId,
              dispatchReason: reasonBlob,
              engagementMode: EngagementMode.EXECUTE,
              via: "agent-request",
              sourceCommentId: comment.id,
              issueId: input.issueId,
              issuePrefix,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          await maybeApplyAgentTemplate(tx, input.issueId, executeAssignment.agentId);
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: authoringAgentId,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          after: comment,
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: input.issueId,
          payload: {
            commentId: comment.id,
            ...(agentRequestsJson.length > 0 ? { sourceCommentId: comment.id } : {}),
            issueId: input.issueId,
            issuePrefix,
            number: issue.number,
            title: issue.title,
            actorName: ctx.session.user.name ?? ctx.session.user.email ?? "Someone",
            preview: input.body.slice(0, 120),
            mentions: {
              agentIds: mentionedAgents.map((m) => m.agentId),
              userIds: mentionedUsers.map((m) => m.userId),
              agents: mentionedAgents,
            },
            mentionsCount: mentionedAgents.length + mentionedUsers.length,
            agentRequests: agentRequestsJson,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { comment, authoringAgentId };
      });
      // ActionRequest is created *outside* the comment transaction so
      // its own per-row recordChange + emit can run with the standard
      // service entrypoint (which itself opens a transaction). The
      // service guarantees the request points at this workspace and
      // payload references stay scoped — failure here propagates and
      // the comment still exists, surfacing as a partial state the
      // operator can recover from manually (a rare edge: payload
      // validation passes pre-creation, so the realistic failure
      // window is vanishingly small).
      if (input.actionRequest) {
        await createActionRequest(ctx.db, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: result.authoringAgentId,
          title: input.actionRequest.title,
          body: input.actionRequest.body ?? null,
          severity: input.actionRequest.severity,
          kind: input.actionRequest.kind,
          payload: input.actionRequest.payload,
          options: input.actionRequest.options ?? null,
          assignedUserId: input.actionRequest.assignedUserId ?? null,
          assignedAgentId: input.actionRequest.assignedAgentId ?? null,
          sourceType: "comment",
          sourceId: result.comment.id,
          issueId: input.issueId,
          dueAt: input.actionRequest.dueAt ?? null,
        });
      }
      return result.comment;
    }),

  /**
   * Edit a comment body. Pushes the OLD body + the row's previous
   * `updatedAt` onto `revisions` before applying the patch so the
   * history is preserved. Capped at `BODY_REVISION_CAP` entries —
   * oldest dropped first to keep the column bounded.
   *
   * `editedAt` is bumped to `new Date()` so the timeline can show
   * "edited 3 minutes ago" without conflating with `updatedAt`
   * (Prisma touches that on every column change, including chip
   * tweaks and confidence flips).
   */
  update: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), body: z.string().min(1).max(50_000) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.comment.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          body: true,
          issueId: true,
          kind: true,
          updatedAt: true,
          revisions: true,
        },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Comment not found in this workspace.",
        });
      }
      // No-op when the body hasn't actually changed. Keeps the
      // history clean — the UI's edit-and-immediately-save path
      // shouldn't accumulate identical rows.
      if (existing.body === input.body) {
        return ctx.db.comment.findUniqueOrThrow({ where: { id: input.id } });
      }
      const priorRevisions = Array.isArray(existing.revisions)
        ? (existing.revisions as Prisma.JsonArray)
        : [];
      const nextRevisions: Prisma.JsonArray = [
        ...priorRevisions,
        {
          body: existing.body,
          editedAt: existing.updatedAt.toISOString(),
        },
      ].slice(-BODY_REVISION_CAP);
      const now = new Date();

      // Mention diff: only @-tokens that are NEW in this edit get
      // resolved + dispatched. Tokens already present in the old body
      // were dispatched at create time (or a prior edit), so we don't
      // re-trigger them — keeps the agent-trigger path idempotent so an
      // operator can fix a typo without re-paging everyone. Tokens are
      // lower-cased by `extractMentions`, matching profileKey / handle.
      const oldTokens = new Set(extractMentions(existing.body));
      const newTokens = extractMentions(input.body);
      const addedTokens = newTokens.filter((t) => !oldTokens.has(t));

      // Execution-step comments (issueId null) have no issue thread to
      // fan out on — just persist the body. The mention-dispatch path
      // below is issue-scoped only.
      const issueId = existing.issueId;
      if (!issueId) {
        return ctx.db.comment.update({
          where: { id: input.id },
          data: {
            body: input.body,
            revisions: nextRevisions,
            editedAt: now,
            updatedAt: now,
          },
        });
      }

      return ctx.db.$transaction(async (tx) => {
        const updated = await tx.comment.update({
          where: { id: input.id },
          data: {
            body: input.body,
            revisions: nextRevisions,
            editedAt: now,
            updatedAt: now,
          },
          include: {
            author: { select: { id: true, name: true, image: true } },
            authoringAgent: {
              select: { id: true, name: true, profileKey: true, avatar: true },
            },
          },
        });

        // Resolve only the ADDED tokens against agents + workspace users,
        // exactly like `comment.create` does. Subscribe them as watchers
        // and stash the resolved agent ids so the audit fan-out can fire
        // a one-shot dispatch for the newly-added agent mentions.
        const newlyMentionedAgents: Array<{ agentId: string; profileKey: string }> = [];
        const newlyMentionedUsers: Array<{ userId: string; handle: string }> = [];
        if (addedTokens.length) {
          const [agentMatches, userMatches] = await Promise.all([
            tx.agent.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                profileKey: { in: addedTokens },
                archivedAt: null,
              },
              select: { id: true, profileKey: true },
            }),
            tx.user.findMany({
              where: {
                handle: { in: addedTokens },
                memberships: { some: { workspaceId: ctx.workspaceId } },
              },
              select: { id: true, handle: true },
            }),
          ]);
          for (const a of agentMatches) {
            newlyMentionedAgents.push({ agentId: a.id, profileKey: a.profileKey });
          }
          for (const u of userMatches) {
            if (u.handle) {
              newlyMentionedUsers.push({ userId: u.id, handle: u.handle });
            }
          }
          for (const m of newlyMentionedAgents) {
            await autoWatchAgent(tx, {
              workspaceId: ctx.workspaceId,
              issueId,
              agentId: m.agentId,
            });
          }
          for (const m of newlyMentionedUsers) {
            await autoWatchUser(tx, {
              workspaceId: ctx.workspaceId,
              issueId,
              userId: m.userId,
            });
          }
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Comment",
          entityId: updated.id,
          action: "update",
          before: { body: existing.body },
          after: updated,
          eventKind: EventKind.COMMENT_UPDATED,
          subjectType: "issue",
          subjectId: issueId,
          payload: {
            commentId: updated.id,
            issueId,
            edited: true,
            preview: input.body.slice(0, 120),
            // `mentions.agentIds` here is the DIFF (newly-added only) —
            // NOT every mention in the body. Audit branch (c) dispatches
            // a webhook for each, so an edit that adds `@victor` triggers
            // him exactly like a fresh comment would, while pre-existing
            // mentions stay quiet. STATUS-comment updates never come
            // through this path (they use `comments.upsertStatus`), so
            // rolling status heartbeats won't re-page anyone.
            mentions: {
              agentIds: newlyMentionedAgents.map((m) => m.agentId),
              userIds: newlyMentionedUsers.map((m) => m.userId),
              agents: newlyMentionedAgents,
            },
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return updated;
      });
    }),

  /**
   * Read the revision history for a comment. Returns the `revisions`
   * array (oldest first) plus the current `body` so the caller can
   * render the full timeline in one shot.
   */
  history: workspaceProcedure
    .input(z.object({ commentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.comment.findFirst({
        where: { id: input.commentId, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          body: true,
          editedAt: true,
          updatedAt: true,
          revisions: true,
          kind: true,
        },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Comment not found in this workspace.",
        });
      }
      const revisions = Array.isArray(row.revisions) ? (row.revisions as Prisma.JsonArray) : [];
      return {
        id: row.id,
        currentBody: row.body,
        editedAt: row.editedAt,
        updatedAt: row.updatedAt,
        kind: row.kind,
        revisions,
      };
    }),

  softDelete: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.comment.update({ where: { id: input.id }, data: { deletedAt: new Date() } }),
    ),

  /**
   * Rolling live status comment for the calling agent's current run on
   * `issueId`. Idempotent: if no STATUS comment exists for the active
   * run, one is created; otherwise the existing one is updated and the
   * previous body + currentStep are pushed onto `revisions`.
   *
   * Caller must authenticate via an Agent-linked API key
   * (`ctx.apiKey.linkedAgentId`). Humans should use `comment.create` for
   * regular thread comments — STATUS is an agent-only surface.
   */
  upsertStatus: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        body: z.string().min(1).max(50_000),
        currentStep: z.string().max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agentId = ctx.apiKey?.linkedAgentId ?? null;
      if (!agentId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "comment.upsertStatus is restricted to agent-linked API keys.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        // Open or touch the AgentRun first — every status upsert is also
        // a heartbeat for the run, so the freshness clock resets and the
        // live pulse strip stays warm even on long-running steps.
        const { run, isNew } = await openOrTouchRun(tx, {
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          agentId,
          actorId: ctx.session.user.id,
          actorAgentId: agentId,
          currentStep: input.currentStep ?? null,
        });

        // Look for an existing STATUS comment linked to this run. The
        // 1:1 (Comment.runId @unique) constraint guarantees at most one.
        const existing = await tx.comment.findFirst({
          where: { runId: run.id, kind: CommentKind.STATUS },
        });

        let comment;
        if (!existing) {
          comment = await tx.comment.create({
            data: {
              workspaceId: ctx.workspaceId,
              issueId: input.issueId,
              authorId: ctx.session.user.id,
              authoringAgentId: agentId,
              body: input.body,
              kind: CommentKind.STATUS,
              runId: run.id,
              currentStep: input.currentStep ?? null,
              revisions: [],
            },
            include: {
              author: { select: { id: true, name: true, image: true } },
              authoringAgent: {
                select: { id: true, name: true, profileKey: true, avatar: true },
              },
            },
          });
        } else {
          // Push the prior body onto revisions, capping the array so we
          // don't grow unboundedly on a chatty agent. Order: oldest
          // first; newest is always `body`.
          const priorRevisions = Array.isArray(existing.revisions)
            ? (existing.revisions as Prisma.JsonArray)
            : [];
          const nextRevisions: Prisma.JsonArray = [
            ...priorRevisions,
            {
              body: existing.body,
              currentStep: existing.currentStep,
              ts: existing.updatedAt.toISOString(),
            },
          ].slice(-STATUS_REVISION_CAP);
          comment = await tx.comment.update({
            where: { id: existing.id },
            data: {
              body: input.body,
              currentStep: input.currentStep ?? null,
              revisions: nextRevisions,
              updatedAt: new Date(),
            },
            include: {
              author: { select: { id: true, name: true, image: true } },
              authoringAgent: {
                select: { id: true, name: true, profileKey: true, avatar: true },
              },
            },
          });
        }

        // Append a STATUS event to the run's timeline. We intentionally
        // skip this on the very first call (when openOrTouchRun just
        // wrote a STARTED event) so the timeline doesn't open with two
        // adjacent rows.
        if (!isNew) {
          await appendRunEvent(tx, {
            runId: run.id,
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId,
            kind: "STATUS",
            payload: { commentId: comment.id, preview: input.body.slice(0, 120) },
            currentStep: input.currentStep ?? null,
          });
        }

        // Mention fan-out — same pattern as comment.create so an agent
        // status that @-mentions another agent still routes to that
        // agent's webhook, and a status that @-mentions a human
        // subscribes them as a watcher.
        const tokens = extractMentions(input.body);
        const mentionedAgents: Array<{ agentId: string; profileKey: string }> = [];
        const mentionedUsers: Array<{ userId: string; handle: string }> = [];
        if (tokens.length) {
          const [agentMatches, userMatches] = await Promise.all([
            tx.agent.findMany({
              where: {
                workspaceId: ctx.workspaceId,
                profileKey: { in: tokens },
                archivedAt: null,
              },
              select: { id: true, profileKey: true },
            }),
            tx.user.findMany({
              where: {
                handle: { in: tokens },
                memberships: { some: { workspaceId: ctx.workspaceId } },
              },
              select: { id: true, handle: true },
            }),
          ]);
          for (const a of agentMatches) {
            mentionedAgents.push({ agentId: a.id, profileKey: a.profileKey });
          }
          for (const u of userMatches) {
            if (u.handle) {
              mentionedUsers.push({ userId: u.id, handle: u.handle });
            }
          }
        }

        // Auto-watch mentioned humans (agent watchers are handled by
        // the audit branch (c) + (e) fan-out plus the per-agent shim).
        for (const m of mentionedUsers) {
          await autoWatchUser(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            userId: m.userId,
          });
        }
        for (const m of mentionedAgents) {
          await autoWatchAgent(tx, {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            agentId: m.agentId,
          });
        }

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: agentId,
          entity: "Comment",
          entityId: comment.id,
          action: existing ? "update-status" : "create-status",
          after: comment,
          eventKind: existing ? EventKind.COMMENT_UPDATED : EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: input.issueId,
          payload: {
            commentId: comment.id,
            issueId: input.issueId,
            kind: "STATUS",
            runId: run.id,
            preview: input.body.slice(0, 120),
            currentStep: input.currentStep ?? null,
            mentions: {
              agentIds: mentionedAgents.map((m) => m.agentId),
              userIds: mentionedUsers.map((m) => m.userId),
              agents: mentionedAgents,
            },
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return comment;
      });
    }),
});
