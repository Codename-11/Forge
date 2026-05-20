import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { CommentKind, EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { extractMentions } from "@/server/services/mentions";
import { openOrTouchRun, appendRunEvent } from "@/server/services/agent-run";
import {
  autoWatchActor,
  autoWatchAgent,
  autoWatchUser,
} from "@/server/services/issue-watchers";

const STATUS_REVISION_CAP = 50;

export const commentRouter = router({
  create: workspaceProcedure
    .input(z.object({ issueId: z.string().cuid(), body: z.string().min(1).max(50_000) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        // If the caller authenticated via an API key that is linked to an
        // Agent (the common case for Victor/Mizu automations), stamp the
        // comment with that agent so the UI can render "<Agent> (agent)"
        // instead of the human key owner. Human sessions leave it null.
        const authoringAgentId = ctx.apiKey?.linkedAgentId ?? null;

        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: input.issueId,
            authorId: ctx.session.user.id,
            body: input.body,
            authoringAgentId,
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

        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          after: comment,
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: input.issueId,
          payload: {
            commentId: comment.id,
            issueId: input.issueId,
            preview: input.body.slice(0, 120),
            // Structured mentions payload. `agentIds[]` powers branch (c)
            // in audit.ts's per-agent webhook dispatch; `userIds[]` is
            // read by the notification materializer so human mentions
            // count toward "involved" for notification gating.
            mentions: {
              agentIds: mentionedAgents.map((m) => m.agentId),
              userIds: mentionedUsers.map((m) => m.userId),
              // Legacy array shape preserved for any consumer that
              // hasn't migrated yet (the audit branch reads `agents` /
              // falls back). Slated for removal once all readers move
              // to the structured fields.
              agents: mentionedAgents,
            },
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return comment;
      });
    }),

  update: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), body: z.string().min(1).max(50_000) }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.comment.update({
        where: { id: input.id },
        data: { body: input.body, updatedAt: new Date() },
      }),
    ),

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
          message:
            "comment.upsertStatus is restricted to agent-linked API keys.",
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
