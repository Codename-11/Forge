import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, Prisma, Priority, RelationKind, StatusCategory, WorkItemKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { assertKeyScope, buildKeyScopeWhere } from "@/server/services/api-key-auth";
import {
  maybeAutoDispatch,
  recordManualDispatchReason,
} from "@/server/services/dispatcher";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";
import { triageIssue } from "@/server/services/ai-triage";
import { finishRunsForIssue, recordAgentAction } from "@/server/services/agent-run";
import { agentId as agentIdSchema } from "./agent";
import { UPDATED_SINCE_VALUES, updatedSinceToDate } from "@/lib/saved-view-filters";

const cursorSchema = z.string().optional();

const filterSchema = z.object({
  // -- Singleton filters (kept for back-compat with existing call-sites). --
  projectId: z.string().cuid().optional(),
  statusId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().optional(),
  priority: z.nativeEnum(Priority).optional(),
  query: z.string().max(200).optional(),
  includeDone: z.boolean().default(true),
  /**
   * Cycle filter. `undefined` = any cycle (no filter). Pass a cycle id to
   * pin. Pass `null` to match "backlog" — issues with no cycle.
   */
  cycleId: z.string().cuid().nullable().optional(),
  /**
   * Initiative filter — joins through `project.initiativeId`. `undefined`
   * for no filter; `null` matches issues whose project has no initiative
   * (or no project at all).
   */
  initiativeId: z.string().cuid().nullable().optional(),
  /**
   * Agent-assignment filter. `undefined` = no filter. Pass an agent id
   * to pin; pass `null` to match issues with no agent assigned.
   */
  assignedAgentId: agentIdSchema.nullable().optional(),

  // -- Array / projection filters (Phase 1D saved-views). --------------------
  // Any-of semantics. AND'd with singleton equivalents above when both pass.
  projectIds: z.array(z.string().cuid()).max(100).optional(),
  statusIds: z.array(z.string().cuid()).max(100).optional(),
  statusCategories: z.array(z.nativeEnum(StatusCategory)).max(8).optional(),
  assigneeIds: z.array(z.string().cuid()).max(100).optional(),
  labelIds: z.array(z.string().cuid()).max(100).optional(),
  initiativeIds: z.array(z.string().cuid()).max(100).optional(),
  cycleIds: z.array(z.string().cuid()).max(100).optional(),
  priorities: z.array(z.nativeEnum(Priority)).max(8).optional(),
  /** Match issues whose project has no initiative (or no project at all). */
  withoutInitiative: z.boolean().optional(),
  /** Match issues with no cycle assignment. */
  withoutCycle: z.boolean().optional(),
  /** Match issues with no human assignees AND no agent. */
  unassigned: z.boolean().optional(),
  /** Match issues blocked by an open dependency. */
  blocked: z.boolean().optional(),
  /** Window: only issues updated within the last N days. */
  updatedSince: z.enum(UPDATED_SINCE_VALUES).optional(),
  /**
   * Filter out issues whose `snoozedUntil` is still in the future. Default
   * `false` keeps the public schema permissive (consumers asking for "all
   * issues" expect snoozed ones to be visible). Stalled-style consumers
   * (inbox, dashboard suggestions) pass `true`.
   */
  excludeSnoozed: z.boolean().default(false),

  limit: z.number().min(1).max(500).default(50),
  cursor: cursorSchema,
});

export const issueRouter = router({
  list: workspaceProcedure
    .input(filterSchema.default({ includeDone: true, limit: 50 }))
    .query(async ({ ctx, input }) => {
      const keyWhere = buildKeyScopeWhere(ctx, "issue");
      // Compose optional OR clauses under AND so multiple predicates that
      // each need OR (query, initiativeId=null) don't clobber each other.
      const andClauses: Array<Record<string, unknown>> = [];
      if (input.initiativeId === null || input.withoutInitiative === true) {
        andClauses.push({
          OR: [{ projectId: null }, { project: { initiativeId: null } }],
        });
      }
      if (input.query) {
        andClauses.push({
          OR: [
            { title: { contains: input.query, mode: "insensitive" } },
            { description: { contains: input.query, mode: "insensitive" } },
          ],
        });
      }

      // `unassigned` = no human assignees AND no agent. Implemented as a
      // single AND so it composes with explicit assigneeIds / assignedAgentId.
      if (input.unassigned === true) {
        andClauses.push({
          AND: [{ assignees: { none: {} } }, { assignedAgentId: null }],
        });
      }

      // Status: combine `statusIds[]` and `statusCategories[]` under OR
      // when both are present so saved views can pin "any of {Backlog} OR
      // exact id Foo" without needing two views. When only one is set we
      // emit the simpler clause.
      let statusClause: Record<string, unknown> | null = null;
      if (input.statusIds?.length && input.statusCategories?.length) {
        statusClause = {
          OR: [
            { statusId: { in: input.statusIds } },
            { status: { category: { in: input.statusCategories } } },
          ],
        };
      } else if (input.statusIds?.length) {
        statusClause = { statusId: { in: input.statusIds } };
      } else if (input.statusCategories?.length) {
        statusClause = { status: { category: { in: input.statusCategories } } };
      }
      if (statusClause) andClauses.push(statusClause);

      // Cycle: array form. The `withoutCycle` boolean appends a `cycleId
      // IS NULL` branch under OR so a saved view can express "in sprint
      // X OR uncycled" if it ever wants to. The single `cycleId` field
      // (above) keeps prior behavior.
      if (input.cycleIds?.length || input.withoutCycle === true) {
        const ors: Array<Record<string, unknown>> = [];
        if (input.cycleIds?.length) ors.push({ cycleId: { in: input.cycleIds } });
        if (input.withoutCycle === true) ors.push({ cycleId: null });
        andClauses.push({ OR: ors });
      }

      // Initiative array: joins through project.initiativeId. The
      // `withoutInitiative` toggle is already handled above; this branch
      // adds the explicit-id case.
      if (input.initiativeIds?.length) {
        andClauses.push({
          project: { initiativeId: { in: input.initiativeIds } },
        });
      }

      // `blocked: true` resolves the blocked-set up front and constrains
      // the row id. Skipped when false/undefined to keep the unblocked
      // path on a single query.
      let blockedConstraint: Record<string, unknown> | null = null;
      if (input.blocked === true) {
        const blocked = await findBlockedIssueIds(ctx);
        if (blocked.size === 0) {
          // Nothing blocked → return early with an empty page.
          return { items: [], nextCursor: undefined };
        }
        blockedConstraint = { id: { in: [...blocked] } };
      }

      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.projectIds?.length
            ? { projectId: { in: input.projectIds } }
            : {}),
          ...(input.statusId ? { statusId: input.statusId } : {}),
          ...(input.assigneeId ? { assignees: { some: { userId: input.assigneeId } } } : {}),
          ...(input.assigneeIds?.length
            ? { assignees: { some: { userId: { in: input.assigneeIds } } } }
            : {}),
          ...(input.labelIds?.length
            ? { labels: { some: { labelId: { in: input.labelIds } } } }
            : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.priorities?.length
            ? { priority: { in: input.priorities } }
            : {}),
          ...(input.cycleId === null
            ? { cycleId: null }
            : input.cycleId
              ? { cycleId: input.cycleId }
              : {}),
          ...(typeof input.initiativeId === "string"
            ? { project: { initiativeId: input.initiativeId } }
            : {}),
          ...(input.assignedAgentId === null
            ? { assignedAgentId: null }
            : input.assignedAgentId
              ? { assignedAgentId: input.assignedAgentId }
              : {}),
          ...(input.updatedSince
            ? { updatedAt: { gte: updatedSinceToDate(input.updatedSince) } }
            : {}),
          ...(input.excludeSnoozed
            ? {
                OR: [
                  { snoozedUntil: null },
                  { snoozedUntil: { lte: new Date() } },
                ],
              }
            : {}),
          ...(input.includeDone ? {} : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
          ...(blockedConstraint ?? {}),
          ...(andClauses.length ? { AND: andClauses } : {}),
        },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        include: {
          status: true,
          project: { select: { id: true, key: true, name: true, color: true, icon: true } },
          assignees: { include: { user: { select: { id: true, name: true, image: true } } } },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
            },
          },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
        },
      });
      let nextCursor: string | undefined;
      if (rows.length > input.limit) nextCursor = rows.pop()!.id;
      const withFlags = await annotateUnblocked(ctx, rows);
      return { items: withFlags, nextCursor };
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
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              avatar: true,
              status: true,
            },
          },
          labels: { include: { label: true } },
          comments: {
            orderBy: { createdAt: "asc" },
            include: {
              author: { select: { id: true, name: true, image: true } },
              authoringAgent: {
                select: { id: true, name: true, profileKey: true, avatar: true },
              },
            },
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

  /**
   * Activity stream for a single issue — the audit-backed `ActivityEvent`
   * rows that share the issue's id as `subjectId`. Workspace-scoped so
   * any member can view (unlike `admin.events` which is OWNER/ADMIN only).
   * Feeds the Activity tab on the issue detail right-rail.
   */
  activity: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Confirm the issue exists and lives in this tenant before reading
      // its events — avoids leaking cross-tenant subjectIds through guesses.
      const issue = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!issue) throw new TRPCError({ code: "NOT_FOUND" });
      const rows = await ctx.db.activityEvent.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          subjectType: "issue",
          subjectId: input.issueId,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        include: { actor: { select: { id: true, name: true, image: true } } },
      });
      return rows;
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
        assignedAgentId: agentIdSchema.optional(),
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

        // Cross-tenant guard: agent must live in this workspace.
        if (input.assignedAgentId) {
          const agent = await tx.agent.findFirst({
            where: { id: input.assignedAgentId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!agent) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Agent not found in this workspace.",
            });
          }
        }

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
            assignedAgentId: input.assignedAgentId,
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
        if (input.assignedAgentId) {
          // Stamp a manual `dispatchReason` blob so the attribution
          // chip can render even when an operator picked the agent
          // directly (rather than the auto-dispatcher).
          const agentRow = await tx.agent.findUniqueOrThrow({
            where: { id: input.assignedAgentId },
            select: { profileKey: true },
          });
          const reasonBlob = await recordManualDispatchReason(tx, {
            issueId: issue.id,
            agentProfileKey: agentRow.profileKey,
            actorId: ctx.session.user.id,
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: issue.id,
            action: "assign-agent",
            after: { assignedAgentId: input.assignedAgentId },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              agentId: input.assignedAgentId,
              previousAgentId: null,
              dispatchReason: reasonBlob,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          // Apply the agent's template if the description is empty. No-op
          // when the caller supplied a description or the agent has no
          // template configured.
          await maybeApplyAgentTemplate(tx, issue.id, input.assignedAgentId);
        }
        // `maybeAutoDispatch` handles its own template application when it
        // picks an agent — no need to double-call from here.
        await maybeAutoDispatch(tx, issue.id);
        return issue;
      }).then((issue) => {
        // Fire-and-forget AI triage. Skipped server-side when AI is off
        // or already-triaged. Runs out-of-band so create stays sub-100ms
        // even when the LLM call takes seconds. We don't await — clients
        // poll via the issue.byId query (toaster/realtime invalidation
        // surfaces the chip when ready).
        if (!ctx.apiKey) {
          // Only auto-triage human-authored issues. Skip when an agent
          // creates an issue via API key (saves cost on bulk creates).
          void triageIssue(issue.id);
        }
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
        assignedAgentId: agentIdSchema.nullable().optional(),
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

        // Cross-tenant guard: if the caller tries to move the issue to a
        // project or status in a different workspace, reject.
        if (patch.projectId) {
          const proj = await tx.project.findFirst({
            where: { id: patch.projectId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!proj) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Project not found in this workspace.",
            });
          }
        }
        if (patch.statusId) {
          const st = await tx.status.findFirst({
            where: { id: patch.statusId, workspaceId: ctx.workspaceId },
            select: { id: true, category: true },
          });
          if (!st) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Status not found in this workspace.",
            });
          }
        }
        // Cross-tenant guard: agent must live in this workspace when set.
        if (patch.assignedAgentId) {
          const agent = await tx.agent.findFirst({
            where: { id: patch.assignedAgentId, workspaceId: ctx.workspaceId },
            select: { id: true },
          });
          if (!agent) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Agent not found in this workspace.",
            });
          }
        }

        // Mark lifecycle timestamps based on status category transitions.
        const extra: { startedAt?: Date; completedAt?: Date | null; canceledAt?: Date | null } = {};
        let nextCategory: string | null = null;
        if (patch.statusId && patch.statusId !== before.statusId) {
          const next = await tx.status.findFirstOrThrow({
            where: { id: patch.statusId, workspaceId: ctx.workspaceId },
          });
          nextCategory = next.category;
          if (next.category === "IN_PROGRESS" && !before.startedAt) extra.startedAt = new Date();
          if (next.category === "DONE") extra.completedAt = new Date();
          if (next.category === "CANCELED") extra.canceledAt = new Date();
          if (next.category !== "DONE") extra.completedAt = null;
          if (next.category !== "CANCELED") extra.canceledAt = null;
        }

        const updateRes = await tx.issue.updateMany({
          where: { id, workspaceId: ctx.workspaceId },
          data: { ...patch, ...extra },
        });
        if (updateRes.count === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
        }
        const after = await tx.issue.findUniqueOrThrow({
          where: { id },
          include: { status: true },
        });

        // Generic update event — status changes re-label this so existing
        // ISSUE_STATUS_CHANGED subscribers keep working. Priority changes
        // additionally emit ISSUE_PRIORITY_CHANGED below so the webhook bus
        // + agent-dispatch escalation path can route on the specific kind
        // without walking the generic payload.
        const kind =
          patch.statusId && patch.statusId !== before.statusId
            ? EventKind.ISSUE_STATUS_CHANGED
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

        // Priority transitions get a dedicated event so downstream webhook
        // subscribers + the agent-dispatch escalation path (HIGH/URGENT)
        // can route precisely without parsing patch diffs.
        if (patch.priority && patch.priority !== before.priority) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: id,
            action: "change-priority",
            before: { priority: before.priority },
            after: { priority: patch.priority },
            eventKind: EventKind.ISSUE_PRIORITY_CHANGED,
            subjectType: "issue",
            subjectId: id,
            payload: { from: before.priority, to: patch.priority },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }

        // Agent-assignment changes get a dedicated event so the activity
        // stream / webhook bus can route on `AGENT_ASSIGNED` without
        // parsing `payload` for every generic ISSUE_UPDATED.
        const agentProvided = Object.prototype.hasOwnProperty.call(patch, "assignedAgentId");
        if (agentProvided && (patch.assignedAgentId ?? null) !== (before.assignedAgentId ?? null)) {
          // Manual assignment / unassignment — stamp a `dispatchReason`
          // when an agent is being set, clear it on unassign.
          let manualReason: Record<string, unknown> | null = null;
          if (patch.assignedAgentId) {
            const agentRow = await tx.agent.findUniqueOrThrow({
              where: { id: patch.assignedAgentId },
              select: { profileKey: true },
            });
            manualReason = (await recordManualDispatchReason(tx, {
              issueId: id,
              agentProfileKey: agentRow.profileKey,
              actorId: ctx.session.user.id,
            })) as Record<string, unknown>;
          } else {
            // Cleared assignment — drop the previous reason.
            await tx.issue.update({
              where: { id },
              data: { dispatchReason: Prisma.JsonNull },
            });
          }
          const assignmentPayload: Prisma.InputJsonObject = {
            agentId: patch.assignedAgentId ?? null,
            previousAgentId: before.assignedAgentId,
            ...(manualReason ? { dispatchReason: manualReason as Prisma.InputJsonObject } : {}),
          };
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: id,
            action: "assign-agent",
            before: { assignedAgentId: before.assignedAgentId },
            after: { assignedAgentId: patch.assignedAgentId ?? null },
            eventKind: EventKind.AGENT_ASSIGNED,
            subjectType: "issue",
            subjectId: id,
            payload: assignmentPayload,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          // Apply template on assignment (or re-assignment) when the
          // new agent has one and the current description is empty.
          // The helper itself no-ops on both missing template and non-
          // empty description, so re-assignment to a different agent on
          // an already-populated issue won't clobber prior content.
          if (patch.assignedAgentId) {
            await maybeApplyAgentTemplate(tx, id, patch.assignedAgentId);
          }
        }

        // AgentRun lifecycle: when the issue lands in a terminal status
        // (DONE / CANCELED) close any ACTIVE runs so the live pulse
        // strip drops off the issue page. ABANDONED on cancel keeps the
        // distinction between "agent finished" and "operator killed it."
        if (nextCategory === "DONE" || nextCategory === "CANCELED") {
          await finishRunsForIssue(tx, {
            workspaceId: ctx.workspaceId,
            issueId: id,
            status: nextCategory === "DONE" ? "COMPLETED" : "ABANDONED",
            actorId: ctx.session.user.id,
          });
        } else if (
          // Touch the run on transition by the assigned agent so the
          // status-change is reflected in the timeline as a STEP event.
          before.assignedAgentId &&
          patch.statusId &&
          patch.statusId !== before.statusId
        ) {
          await recordAgentAction(tx, {
            workspaceId: ctx.workspaceId,
            issueId: id,
            agentId: before.assignedAgentId,
            kind: "TRANSITION",
            payload: { from: before.statusId, to: patch.statusId, category: nextCategory },
            actorId: ctx.session.user.id,
          });
        }

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
    .mutation(async ({ ctx, input }) => {
      const res = await ctx.db.issue.updateMany({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        data: { deletedAt: new Date() },
      });
      if (res.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Issue not found in this workspace." });
      }
      return { ok: true };
    }),

  bulkStatus: workspaceProcedure
    .input(z.object({ ids: z.array(z.string().cuid()).max(200), statusId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      ctx.db.issue.updateMany({
        where: { id: { in: input.ids }, workspaceId: ctx.workspaceId },
        data: { statusId: input.statusId },
      }),
    ),

  /**
   * Bulk add/remove labels across many issues in one RPC. All referenced
   * label ids are validated to live in the same workspace as the issues
   * (one query, not N). Audit + activity events are written per issue via
   * `recordChange()` so the invariant "audit log and activity event live
   * together" holds — chunked into 50s inside a single transaction to
   * keep the tx small.
   */
  bulkSetLabels: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        add: z.array(z.string().cuid()).default([]),
        remove: z.array(z.string().cuid()).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) {
        return { updated: 0, added: 0, removed: 0 };
      }
      const labelIds = Array.from(new Set([...input.add, ...input.remove]));
      if (labelIds.length > 0) {
        const found = await ctx.db.label.findMany({
          where: { id: { in: labelIds }, workspaceId: ctx.workspaceId },
          select: { id: true },
        });
        if (found.length !== labelIds.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "One or more labels do not belong to this workspace.",
          });
        }
      }

      return ctx.db.$transaction(async (tx) => {
        // Filter issueIds to those that actually exist in this workspace.
        // updateMany's where-scope on the join rows already enforces
        // workspaceId via the issue fk; we validate to report real counts
        // and to avoid writing audit rows for issues that don't exist.
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) {
          return { updated: 0, added: 0, removed: 0 };
        }

        let added = 0;
        let removed = 0;

        if (input.remove.length > 0) {
          const res = await tx.issueLabel.deleteMany({
            where: {
              issueId: { in: validIds },
              labelId: { in: input.remove },
            },
          });
          removed = res.count;
        }

        if (input.add.length > 0) {
          // Build all (issueId, labelId) pairs; skipDuplicates handles
          // existing rows via the composite @@id([issueId, labelId]).
          const data = validIds.flatMap((issueId) =>
            input.add.map((labelId) => ({ issueId, labelId })),
          );
          const res = await tx.issueLabel.createMany({
            data,
            skipDuplicates: true,
          });
          added = res.count;
        }

        // Chunk audit+event writes so large selections don't blow up a
        // single tx or block other writers for too long.
        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-set-labels",
              after: { add: input.add, remove: input.remove },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { add: input.add, remove: input.remove },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: validIds.length, added, removed };
      });
    }),

  /**
   * Bulk human assignment — sets `Issue.claimedById` (the single-user
   * claim field) on every selected issue. `null` releases the claim.
   * Writes ISSUE_ASSIGNED audit+event per issue.
   */
  bulkAssign: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        claimedById: z.string().cuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) {
        return { updated: 0 };
      }
      // Cross-tenant guard: claimedById must be a workspace member when set.
      if (input.claimedById) {
        const member = await ctx.db.membership.findFirst({
          where: {
            userId: input.claimedById,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!member) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "User is not a member of this workspace.",
          });
        }
      }

      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: {
            claimedById: input.claimedById,
            // Clearing the claim also clears timestamps; setting a new
            // owner refreshes the claim start time.
            claimedAt: input.claimedById ? new Date() : null,
            claimExpiresAt: null,
          },
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-assign",
              after: { claimedById: input.claimedById },
              eventKind: EventKind.ISSUE_ASSIGNED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { claimedById: input.claimedById },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: validIds.length };
      });
    }),

  /**
   * Bulk agent assignment — sets `Issue.assignedAgentId` on every
   * selected issue. `null` releases. Writes AGENT_ASSIGNED per issue,
   * which feeds the existing agent-dispatch webhook fan-out in
   * `recordChange()`.
   */
  bulkAssignAgent: workspaceProcedure
    .input(
      z.object({
        issueIds: z.array(z.string().cuid()).max(500),
        assignedAgentId: agentIdSchema.nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.issueIds.length === 0) {
        return { updated: 0 };
      }
      if (input.assignedAgentId) {
        const agent = await ctx.db.agent.findFirst({
          where: {
            id: input.assignedAgentId,
            workspaceId: ctx.workspaceId,
          },
          select: { id: true },
        });
        if (!agent) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Agent not found in this workspace.",
          });
        }
      }

      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.issueIds },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, assignedAgentId: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };

        // Resolve the bulk-set agent's profileKey once for the
        // dispatchReason stamp (only when assigning, not on clear).
        let agentProfileKey: string | null = null;
        if (input.assignedAgentId) {
          const a = await tx.agent.findUnique({
            where: { id: input.assignedAgentId },
            select: { profileKey: true },
          });
          agentProfileKey = a?.profileKey ?? null;
        }

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: {
            assignedAgentId: input.assignedAgentId,
            ...(input.assignedAgentId ? {} : { dispatchReason: Prisma.JsonNull }),
          },
        });

        // Per-issue dispatchReason stamp (auto-dispatch sets it
        // per-row; mirror that for manual bulk assignment so
        // attribution stays consistent regardless of code path).
        let manualReason: Prisma.InputJsonObject | null = null;
        if (input.assignedAgentId && agentProfileKey) {
          for (const row of issues) {
            manualReason = await recordManualDispatchReason(tx, {
              issueId: row.id,
              agentProfileKey,
              actorId: ctx.session.user.id,
            });
          }
        }

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = issues.slice(i, i + CHUNK);
          for (const row of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: row.id,
              action: "assign-agent",
              before: { assignedAgentId: row.assignedAgentId },
              after: { assignedAgentId: input.assignedAgentId },
              eventKind: EventKind.AGENT_ASSIGNED,
              subjectType: "issue",
              subjectId: row.id,
              payload: {
                agentId: input.assignedAgentId,
                previousAgentId: row.assignedAgentId,
                ...(manualReason ? { dispatchReason: manualReason } : {}),
              },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: validIds.length };
      });
    }),

  setQueued: workspaceProcedure
    .input(z.object({ id: z.string().cuid(), queued: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirstOrThrow({
          where: { id: input.id, workspaceId: ctx.workspaceId },
        });
        const updated = await tx.issue.update({
          where: { id: issue.id },
          data: {
            queued: input.queued,
            // Releasing from queue while claimed leaves the claim intact (agent still owns it).
            ...(!input.queued && issue.claimedAt == null
              ? { claimedAt: null, claimedById: null, claimExpiresAt: null }
              : {}),
          },
        });
        // Emit ISSUE_QUEUED only on the off -> on transition so repeated
        // setQueued(true) calls don't spam agent webhooks. This event is
        // domain-specific; generic ISSUE_UPDATED subscribers are unaffected.
        if (input.queued && !issue.queued) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: issue.id,
            action: "queue",
            before: { queued: issue.queued },
            after: { queued: true },
            eventKind: EventKind.ISSUE_QUEUED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              number: issue.number,
              assignedAgentId: issue.assignedAgentId,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        await maybeAutoDispatch(tx, issue.id);
        return updated;
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
    .query(async ({ ctx, input }) => {
      const keyWhere = buildKeyScopeWhere(ctx, "issue");
      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          ...keyWhere,
          ...(input.includeClaimed ? {} : { claimedAt: null }),
        },
        orderBy: [{ claimedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
        take: input.limit,
        include: {
          status: true,
          project: { select: { id: true, name: true, key: true, color: true } },
          claimedBy: { select: { id: true, name: true, email: true, image: true } },
          assignedAgent: {
            select: {
              id: true,
              name: true,
              profileKey: true,
              status: true,
            },
          },
        },
      });
      return annotateUnblocked(ctx, rows);
    }),

  /**
   * Claim an issue for this user (or for the API key's linked user).
   *
   * - If `issueId` is omitted, pick the highest-priority, oldest-queued,
   *   unclaimed, unblocked issue that respects any active ApiKey narrowing.
   * - If `issueId` is provided, validate the key scope and claim it.
   * An issue is "blocked" when any incoming BLOCKED_BY (or outgoing BLOCKS
   * where it's the `fromIssue`) relation points to another issue whose
   * status category is not DONE or CANCELED.
   */
  claim: workspaceProcedure
    .input(
      z
        .object({
          issueId: z.string().cuid().optional(),
          claimTtlMinutes: z.number().int().min(1).max(1440).default(60),
        })
        .default({}),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const expiresAt = new Date(Date.now() + input.claimTtlMinutes * 60_000);

      if (input.issueId) {
        await assertKeyScope(ctx, { entity: "issue", id: input.issueId });
        return ctx.db.$transaction(async (tx) => {
          const issue = await tx.issue.findFirstOrThrow({
            where: {
              id: input.issueId,
              workspaceId: ctx.workspaceId,
              deletedAt: null,
            },
          });
          if (issue.claimedAt && issue.claimedById !== userId) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Issue already claimed by another agent.",
            });
          }
          return tx.issue.update({
            where: { id: issue.id },
            data: {
              claimedById: userId,
              claimedAt: new Date(),
              claimExpiresAt: expiresAt,
            },
            include: { status: true },
          });
        });
      }

      // Agent "give me something to work on" flow — scan the queue for an
      // unclaimed, unblocked candidate.
      const keyWhere = buildKeyScopeWhere(ctx, "issue");
      const blockedIds = await findBlockedIssueIds(ctx);
      const candidate = await ctx.db.issue.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          queued: true,
          claimedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
          ...keyWhere,
          ...(blockedIds.size ? { id: { notIn: [...blockedIds] } } : {}),
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      });
      if (!candidate) return { claimed: null } as const;
      const updated = await ctx.db.issue.update({
        where: { id: candidate.id },
        data: {
          claimedById: userId,
          claimedAt: new Date(),
          claimExpiresAt: expiresAt,
        },
        include: { status: true, project: true },
      });
      return { claimed: updated };
    }),

  /**
   * Prev/next sibling lookup for the issue-detail keyboard nav (`[` / `]`).
   * Siblings share the issue's project (when scope = "project") or its
   * cycle (when scope = "cycle"); ordered by issue number ascending so
   * the chevron walk reads in the natural identifier order
   * (AXI-41 → AXI-42 → AXI-43). Soft-deleted issues are excluded on both
   * sides. Returns `null` for either end when none exists. Tenant-scoped:
   * a member can't peek into siblings of a different workspace.
   *
   * Why number, not createdAt: number is monotonic per workspace and is
   * the visible identifier — users who hit `]` expect "the next one in
   * the list" to match the issue key sequence they already see.
   * `issue.list` orders by priority/createdAt for the queue surface, but
   * a detail-page keyboard walk wants identifier order.
   */
  siblings: workspaceProcedure
    .input(
      z.object({
        issueId: z.string().cuid(),
        scope: z.enum(["project", "cycle"]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const current = await ctx.db.issue.findFirst({
        where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
        select: {
          id: true,
          number: true,
          projectId: true,
          cycleId: true,
        },
      });
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });

      const scopeWhere =
        input.scope === "project"
          ? { projectId: current.projectId ?? null }
          : { cycleId: current.cycleId ?? null };

      const baseWhere = {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        ...scopeWhere,
      } as const;

      const [prev, next] = await Promise.all([
        ctx.db.issue.findFirst({
          where: { ...baseWhere, number: { lt: current.number } },
          orderBy: { number: "desc" },
          select: { id: true, number: true, title: true, workspace: { select: { key: true } } },
        }),
        ctx.db.issue.findFirst({
          where: { ...baseWhere, number: { gt: current.number } },
          orderBy: { number: "asc" },
          select: { id: true, number: true, title: true, workspace: { select: { key: true } } },
        }),
      ]);

      const shape = (
        row: { id: string; number: number; title: string; workspace: { key: string } } | null,
      ) =>
        row
          ? {
              id: row.id,
              key: `${row.workspace.key}-${row.number}`,
              title: row.title,
            }
          : null;

      return { prev: shape(prev), next: shape(next) };
    }),

  /**
   * Snooze an issue until the given timestamp. While `snoozedUntil` is
   * in the future, inbox + stalled buckets exclude the row (the operator
   * has explicitly asked the system to stop nagging them). Settings-
   * driven consumers (issue.list with `excludeSnoozed: true`) honor the
   * same gate. Snoozing past now is rejected — the front-end is
   * expected to provide a future date.
   */
  snooze: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        until: z.coerce.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.until.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "snoozedUntil must be a future timestamp.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: {
            id: input.id,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, snoozedUntil: true },
        });
        const updated = await tx.issue.update({
          where: { id: before.id },
          data: { snoozedUntil: input.until },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: before.id,
          action: "snooze",
          before: { snoozedUntil: before.snoozedUntil },
          after: { snoozedUntil: input.until },
          eventKind: EventKind.ISSUE_SNOOZED,
          subjectType: "issue",
          subjectId: before.id,
          payload: { until: input.until.toISOString() },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    }),

  /**
   * Clear the snooze flag on an issue, returning it to the inbox /
   * stalled buckets. No-op when the issue isn't currently snoozed
   * (still emits ISSUE_UNSNOOZED so the activity stream reads cleanly).
   */
  unsnooze: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.issue.findFirstOrThrow({
          where: {
            id: input.id,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, snoozedUntil: true },
        });
        const updated = await tx.issue.update({
          where: { id: before.id },
          data: { snoozedUntil: null },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: before.id,
          action: "unsnooze",
          before: { snoozedUntil: before.snoozedUntil },
          after: { snoozedUntil: null },
          eventKind: EventKind.ISSUE_UNSNOOZED,
          subjectType: "issue",
          subjectId: before.id,
          payload: {
            previousSnoozedUntil: before.snoozedUntil?.toISOString() ?? null,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    }),

  /**
   * Bulk snooze — sets `snoozedUntil` on every selected issue. `until: null`
   * clears the snooze (equivalent to calling `unsnooze` for each id). Used
   * by the inbox bulk-action toolbar so the operator can snooze a whole
   * selection without firing N round-trips.
   *
   * Audit + ISSUE_SNOOZED / ISSUE_UNSNOOZED events are written per issue so
   * downstream consumers (activity stream, webhook bus) treat each row as
   * a discrete snooze — same shape as the singleton `snooze` / `unsnooze`.
   */
  snoozeMany: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).min(1).max(200),
        until: z.coerce.date().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.until && input.until.getTime() <= Date.now()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "snoozedUntil must be a future timestamp.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const rows = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true, snoozedUntil: true },
        });
        const validIds = rows.map((r) => r.id);
        if (validIds.length === 0) return { updated: 0 };

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { snoozedUntil: input.until },
        });

        for (const row of rows) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: row.id,
            action: input.until ? "snooze" : "unsnooze",
            before: { snoozedUntil: row.snoozedUntil },
            after: { snoozedUntil: input.until },
            eventKind: input.until
              ? EventKind.ISSUE_SNOOZED
              : EventKind.ISSUE_UNSNOOZED,
            subjectType: "issue",
            subjectId: row.id,
            payload: input.until
              ? { until: input.until.toISOString() }
              : {
                  previousSnoozedUntil: row.snoozedUntil?.toISOString() ?? null,
                },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        return { updated: validIds.length };
      });
    }),

  /**
   * "Gentle nudge" — appends a comment to the issue tagging the
   * assigned agent (when present), which the existing comment fan-out
   * routes to the agent's webhookUrl as a COMMENT_CREATED with a
   * `mentions` array. Default body cites the days-since-update so the
   * agent has context. We piggy-back on comment.create's plumbing
   * (mention resolution, audit fan-out) rather than duplicate it.
   *
   * Per Phase 0 brief: nudge does NOT add a separate webhook event —
   * comment fan-out already reaches the assigned agent.
   */
  nudge: workspaceProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        body: z.string().min(1).max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const issue = await tx.issue.findFirstOrThrow({
          where: {
            id: input.id,
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: {
            id: true,
            updatedAt: true,
            assignedAgent: { select: { id: true, profileKey: true } },
          },
        });
        const daysSince = Math.max(
          1,
          Math.round(
            (Date.now() - issue.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
          ),
        );
        const mention = issue.assignedAgent
          ? `@${issue.assignedAgent.profileKey} `
          : "";
        const body =
          input.body ??
          `${mention}Gentle nudge — this issue has been quiet for ${daysSince} day${daysSince === 1 ? "" : "s"}.`;

        const comment = await tx.comment.create({
          data: {
            workspaceId: ctx.workspaceId,
            issueId: issue.id,
            authorId: ctx.session.user.id,
            body,
          },
        });

        // Build the mentions array the same way comment.create does so
        // the audit fan-out branch (c) routes to the assigned agent's
        // webhook. We only auto-mention the assigned agent here; if
        // the operator wrote a custom body with explicit @mentions
        // they'll be picked up by comment.create's normal flow next
        // time — for nudge we keep it predictable.
        const mentions = issue.assignedAgent
          ? [
              {
                agentId: issue.assignedAgent.id,
                profileKey: issue.assignedAgent.profileKey,
              },
            ]
          : [];

        // Both events fire: COMMENT_CREATED (so the comment shows up
        // in the activity stream + reaches the agent's webhook) and
        // ISSUE_NUDGED (so consumers can distinguish a nudge from a
        // freeform comment without parsing the body).
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Comment",
          entityId: comment.id,
          action: "create",
          after: comment,
          eventKind: EventKind.COMMENT_CREATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            commentId: comment.id,
            issueId: issue.id,
            preview: body.slice(0, 120),
            mentions,
            isNudge: true,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: issue.id,
          action: "nudge",
          eventKind: EventKind.ISSUE_NUDGED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            commentId: comment.id,
            daysSinceUpdate: daysSince,
            agentId: issue.assignedAgent?.id ?? null,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { ok: true, commentId: comment.id, daysSinceUpdate: daysSince };
      });
    }),

  /**
   * Bulk status transition. Distinct from the legacy `bulkStatus`
   * (which is a thin `updateMany` with no audit/event side effects).
   * Fires `recordChange(ISSUE_STATUS_CHANGED)` per row so subscribers
   * (webhooks, dispatch escalation, agent run lifecycle) react the
   * same way they would for single-issue transitions. Honors
   * lifecycle timestamps (`startedAt`, `completedAt`, `canceledAt`)
   * based on the destination category, mirroring the single-issue
   * `update` proc.
   */
  bulkTransition: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).max(500),
        statusId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0 };
      // Tenant-scope guard for the destination status.
      const status = await ctx.db.status.findFirst({
        where: { id: input.statusId, workspaceId: ctx.workspaceId },
        select: { id: true, category: true },
      });
      if (!status) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Status not found in this workspace.",
        });
      }

      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: {
            id: true,
            statusId: true,
            startedAt: true,
            completedAt: true,
            canceledAt: true,
          },
        });
        // Skip rows already in this status — no-op transitions shouldn't
        // emit audit/event noise.
        const moving = issues.filter((i) => i.statusId !== input.statusId);
        if (moving.length === 0) return { updated: 0 };

        const lifecyclePatch: {
          startedAt?: Date | null;
          completedAt?: Date | null;
          canceledAt?: Date | null;
        } = {};
        // For DONE/CANCELED, set the appropriate stamp. Per-row branch:
        // updateMany doesn't support per-row conditional writes for
        // startedAt (only set when null), so we apply it row-by-row in
        // the audit loop and use updateMany only for the constant fields.
        if (status.category === "DONE") lifecyclePatch.completedAt = new Date();
        if (status.category === "CANCELED") lifecyclePatch.canceledAt = new Date();
        if (status.category !== "DONE") lifecyclePatch.completedAt = null;
        if (status.category !== "CANCELED") lifecyclePatch.canceledAt = null;

        await tx.issue.updateMany({
          where: { id: { in: moving.map((i) => i.id) }, workspaceId: ctx.workspaceId },
          data: { statusId: input.statusId, ...lifecyclePatch },
        });

        // startedAt is conditional ("only set when null") — handled per
        // row so we don't reset an already-running issue's clock.
        if (status.category === "IN_PROGRESS") {
          for (const row of moving) {
            if (!row.startedAt) {
              await tx.issue.update({
                where: { id: row.id },
                data: { startedAt: new Date() },
              });
            }
          }
        }

        const CHUNK = 50;
        for (let i = 0; i < moving.length; i += CHUNK) {
          const chunk = moving.slice(i, i + CHUNK);
          for (const row of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: row.id,
              action: "bulk-transition",
              before: { statusId: row.statusId },
              after: { statusId: input.statusId },
              eventKind: EventKind.ISSUE_STATUS_CHANGED,
              subjectType: "issue",
              subjectId: row.id,
              payload: {
                statusId: input.statusId,
                previousStatusId: row.statusId,
              },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }

        return { updated: moving.length };
      });
    }),

  /**
   * Bulk add a single label to many issues. Idempotent — issues that
   * already carry the label are skipped (composite @@id on IssueLabel
   * + skipDuplicates). Fires ISSUE_UPDATED audit per row; we don't
   * have a dedicated `ISSUE_LABEL_ADDED` enum value, so subscribers
   * key off the action="bulk-add-label" + payload.labelId pair, same
   * as `bulkSetLabels` does.
   */
  bulkAddLabel: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).max(500),
        labelId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0, added: 0 };
      const label = await ctx.db.label.findFirst({
        where: { id: input.labelId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!label) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Label not found in this workspace.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0, added: 0 };

        const res = await tx.issueLabel.createMany({
          data: validIds.map((issueId) => ({ issueId, labelId: input.labelId })),
          skipDuplicates: true,
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-add-label",
              after: { labelId: input.labelId },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { labelId: input.labelId, op: "add" },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }
        return { updated: validIds.length, added: res.count };
      });
    }),

  /**
   * Bulk remove a single label from many issues. Mirror of
   * `bulkAddLabel` for the inverse operation.
   */
  bulkRemoveLabel: workspaceProcedure
    .input(
      z.object({
        ids: z.array(z.string().cuid()).max(500),
        labelId: z.string().cuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0, removed: 0 };
      const label = await ctx.db.label.findFirst({
        where: { id: input.labelId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!label) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Label not found in this workspace.",
        });
      }
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0, removed: 0 };

        const res = await tx.issueLabel.deleteMany({
          where: {
            issueId: { in: validIds },
            labelId: input.labelId,
          },
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-remove-label",
              before: { labelId: input.labelId },
              eventKind: EventKind.ISSUE_UPDATED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { labelId: input.labelId, op: "remove" },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }
        return { updated: validIds.length, removed: res.count };
      });
    }),

  /**
   * Bulk archive (soft-delete) many issues. The Issue schema uses
   * `deletedAt` for soft-delete (no `archivedAt` column on Issue), so
   * "archive" here is the same column the single-issue `softDelete`
   * proc writes to. Per-row ISSUE_DELETED audit fires so subscribers
   * downstream see each issue go away independently.
   */
  bulkArchive: workspaceProcedure
    .input(z.object({ ids: z.array(z.string().cuid()).max(500) }))
    .mutation(async ({ ctx, input }) => {
      if (input.ids.length === 0) return { updated: 0 };
      return ctx.db.$transaction(async (tx) => {
        const issues = await tx.issue.findMany({
          where: {
            id: { in: input.ids },
            workspaceId: ctx.workspaceId,
            deletedAt: null,
          },
          select: { id: true },
        });
        const validIds = issues.map((i) => i.id);
        if (validIds.length === 0) return { updated: 0 };

        const now = new Date();
        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { deletedAt: now },
        });

        const CHUNK = 50;
        for (let i = 0; i < validIds.length; i += CHUNK) {
          const chunk = validIds.slice(i, i + CHUNK);
          for (const issueId of chunk) {
            await recordChange(tx, {
              workspaceId: ctx.workspaceId,
              actorId: ctx.session.user.id,
              entity: "Issue",
              entityId: issueId,
              action: "bulk-archive",
              after: { deletedAt: now },
              eventKind: EventKind.ISSUE_DELETED,
              subjectType: "issue",
              subjectId: issueId,
              payload: { archivedAt: now.toISOString() },
              ip: ctx.ip,
              userAgent: ctx.userAgent,
            });
          }
        }
        return { updated: validIds.length };
      });
    }),
});

// -- Helpers ----------------------------------------------------------------

type IssueRow = { id: string };

/**
 * Return the set of issue ids in `ctx.workspaceId` that are blocked by at
 * least one non-completed dependency. Computed in one query so callers can
 * exclude via `id: { notIn: [...] }` without iterating.
 */
async function findBlockedIssueIds(ctx: {
  db: typeof import("@/server/db").db;
  workspaceId: string;
}): Promise<Set<string>> {
  // Row shape written by `relation.add`:
  //   BLOCKS     : from = blocker, to = blocked
  //   BLOCKED_BY : from = blocked, to = blocker
  // An issue is blocked iff at least one of its blockers is still open
  // (status category not in DONE/CANCELED).
  const blockers = await ctx.db.issueRelation.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      OR: [
        {
          kind: RelationKind.BLOCKS,
          fromIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
        {
          kind: RelationKind.BLOCKED_BY,
          toIssue: {
            status: { category: { notIn: ["DONE", "CANCELED"] } },
            deletedAt: null,
          },
        },
      ],
    },
    select: { fromIssueId: true, toIssueId: true, kind: true },
  });
  const ids = new Set<string>();
  for (const r of blockers) {
    if (r.kind === RelationKind.BLOCKS) ids.add(r.toIssueId);
    if (r.kind === RelationKind.BLOCKED_BY) ids.add(r.fromIssueId);
  }
  return ids;
}

/**
 * Attach an `unblocked` boolean to a batch of issues. Used in agent-facing
 * surfaces (queue, list) so the UI can render a shield indicator without
 * re-fetching the relation graph.
 */
async function annotateUnblocked<T extends IssueRow>(
  ctx: { db: typeof import("@/server/db").db; workspaceId: string },
  rows: T[],
): Promise<Array<T & { unblocked: boolean }>> {
  if (!rows.length) return [];
  const blocked = await findBlockedIssueIds(ctx);
  return rows.map((r) => ({ ...r, unblocked: !blocked.has(r.id) }));
}
