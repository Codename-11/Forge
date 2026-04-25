import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, Priority, RelationKind, WorkItemKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { assertKeyScope, buildKeyScopeWhere } from "@/server/services/api-key-auth";
import { maybeAutoDispatch } from "@/server/services/dispatcher";
import { maybeApplyAgentTemplate } from "@/server/services/agent-template";

const cursorSchema = z.string().optional();

const filterSchema = z.object({
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
  assignedAgentId: z.string().cuid().nullable().optional(),
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
      if (input.initiativeId === null) {
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
      const rows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          deletedAt: null,
          ...keyWhere,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.statusId ? { statusId: input.statusId } : {}),
          ...(input.assigneeId ? { assignees: { some: { userId: input.assigneeId } } } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
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
          ...(input.includeDone ? {} : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
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
        assignedAgentId: z.string().cuid().optional(),
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
        assignedAgentId: z.string().cuid().nullable().optional(),
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
        if (patch.statusId && patch.statusId !== before.statusId) {
          const next = await tx.status.findFirstOrThrow({
            where: { id: patch.statusId, workspaceId: ctx.workspaceId },
          });
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
            payload: {
              agentId: patch.assignedAgentId ?? null,
              previousAgentId: before.assignedAgentId,
            },
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
        assignedAgentId: z.string().cuid().nullable(),
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

        await tx.issue.updateMany({
          where: { id: { in: validIds }, workspaceId: ctx.workspaceId },
          data: { assignedAgentId: input.assignedAgentId },
        });

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
