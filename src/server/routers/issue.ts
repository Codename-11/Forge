import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, Priority, RelationKind, WorkItemKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  assertKeyScope,
  buildKeyScopeWhere,
} from "@/server/services/api-key-auth";

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
          ...(input.includeDone
            ? {}
            : { status: { category: { notIn: ["DONE", "CANCELED"] } } }),
          ...(andClauses.length ? { AND: andClauses } : {}),
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

        // Mark lifecycle timestamps based on status category transitions.
        let extra: { startedAt?: Date; completedAt?: Date | null; canceledAt?: Date | null } = {};
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
