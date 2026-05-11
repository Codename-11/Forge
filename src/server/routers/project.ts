import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, type StatusCategory } from "@prisma/client";
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

  /**
   * Single-procedure rollup for the project detail page. Bundles the
   * project, status counts, the slice of issues in the workspace's
   * current cycle, the linked initiative (if any), recent activity
   * across the project's issues, and members with their open-issue
   * counts. Phase 1 will mount this on the project page so the shell
   * isn't paying for 6 round-trips per render.
   *
   * All counts and lookups are workspace-scoped and respect the
   * existing soft-delete (`deletedAt`) convention. The current-cycle
   * slice is capped at 5 to keep the response payload small — the
   * detail page can deep-link to the full cycle planning board.
   */
  overview: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.project.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId, deletedAt: null },
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      // Status category rollup. Group via Prisma's groupBy on Issue.statusId
      // joined with Status.category — but Prisma can't groupBy across a
      // relation, so we read the Status rows separately and bucket in JS.
      // One round-trip total via a single findMany of project issues with
      // their status; cheaper than a per-bucket count when the project is
      // small-to-medium (< few thousand issues).
      const issueRows = await ctx.db.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          deletedAt: null,
        },
        select: {
          id: true,
          status: { select: { category: true } },
        },
      });

      const counts = {
        total: issueRows.length,
        open: 0,
        inProgress: 0,
        done: 0,
        blocked: 0, // Filled in below from IssueRelation.
      };
      for (const row of issueRows) {
        const cat = row.status.category;
        if (cat === "DONE" || cat === "CANCELED") {
          counts.done += 1;
        } else {
          counts.open += 1;
          if (cat === "IN_PROGRESS" || cat === "IN_REVIEW") {
            counts.inProgress += 1;
          }
        }
      }

      // Blocked-issue count: any project issue that is the target of an
      // open BLOCKS relation, or the source of an open BLOCKED_BY
      // relation. Mirrors the predicate in `findBlockedIssueIds` from
      // issue.ts but scoped to this project.
      if (issueRows.length > 0) {
        const issueIds = issueRows.map((r) => r.id);
        const blockers = await ctx.db.issueRelation.findMany({
          where: {
            workspaceId: ctx.workspaceId,
            OR: [
              {
                kind: "BLOCKS",
                toIssueId: { in: issueIds },
                fromIssue: {
                  status: { category: { notIn: ["DONE", "CANCELED"] } },
                  deletedAt: null,
                },
              },
              {
                kind: "BLOCKED_BY",
                fromIssueId: { in: issueIds },
                toIssue: {
                  status: { category: { notIn: ["DONE", "CANCELED"] } },
                  deletedAt: null,
                },
              },
            ],
          },
          select: { fromIssueId: true, toIssueId: true, kind: true },
        });
        const blockedIds = new Set<string>();
        for (const r of blockers) {
          if (r.kind === "BLOCKS") blockedIds.add(r.toIssueId);
          if (r.kind === "BLOCKED_BY") blockedIds.add(r.fromIssueId);
        }
        counts.blocked = blockedIds.size;
      }

      // Current cycle slice — top 5 open issues from this project that
      // sit in the workspace's currently-ACTIVE cycle. Sorted by
      // priority desc then created asc to match the cycle planning
      // board's reading order.
      const activeCycle = await ctx.db.cycle.findFirst({
        where: { workspaceId: ctx.workspaceId, status: "ACTIVE" },
        orderBy: { startsAt: "desc" },
        select: { id: true, name: true, status: true, endsAt: true },
      });
      let currentCycleSlice:
        | {
            id: string;
            name: string;
            status: string;
            endsAt: Date;
            total: number;
            issues: Array<{
              id: string;
              number: number;
              title: string;
              priority: string;
              status: { id: string; name: string; color: string; category: StatusCategory };
            }>;
          }
        | null = null;
      if (activeCycle) {
        const cycleWhere = {
          workspaceId: ctx.workspaceId,
          projectId: project.id,
          cycleId: activeCycle.id,
          deletedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] as StatusCategory[] } },
        };
        const [total, issues] = await Promise.all([
          ctx.db.issue.count({ where: cycleWhere }),
          ctx.db.issue.findMany({
            where: cycleWhere,
            orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
            take: 5,
            select: {
              id: true,
              number: true,
              title: true,
              priority: true,
              status: { select: { id: true, name: true, color: true, category: true } },
            },
          }),
        ]);
        currentCycleSlice = {
          id: activeCycle.id,
          name: activeCycle.name,
          status: activeCycle.status,
          endsAt: activeCycle.endsAt,
          total,
          issues,
        };
      }

      // Linked initiative — null when project.initiativeId is null.
      let linkedInitiative: {
        id: string;
        slug: string;
        name: string;
        status: string;
      } | null = null;
      if (project.initiativeId) {
        const init = await ctx.db.initiative.findFirst({
          where: { id: project.initiativeId, workspaceId: ctx.workspaceId },
          select: { id: true, slug: true, name: true, status: true },
        });
        linkedInitiative = init ?? null;
      }

      // Recent activity — top 10 ActivityEvent rows where the subject is
      // an issue in this project. We can't filter "project's issues" in
      // a single query without a join, so look up issue ids first then
      // page activity. Cheap because issueIds is already in memory.
      const activityRows = issueRows.length
        ? await ctx.db.activityEvent.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              subjectType: "issue",
              subjectId: { in: issueRows.map((r) => r.id) },
            },
            orderBy: { createdAt: "desc" },
            take: 10,
            include: {
              actor: { select: { id: true, name: true, image: true } },
            },
          })
        : [];
      const activityIssueIds = Array.from(
        new Set(activityRows.map((e) => e.subjectId)),
      );
      const activityIssues = activityIssueIds.length
        ? await ctx.db.issue.findMany({
            where: { id: { in: activityIssueIds } },
            select: {
              id: true,
              number: true,
              title: true,
              status: { select: { id: true, name: true, color: true, category: true } },
            },
          })
        : [];
      const activityIssueById = new Map(activityIssues.map((i) => [i.id, i]));
      const recentActivity = activityRows.map((e) => ({
        ...e,
        issue: activityIssueById.get(e.subjectId) ?? null,
      }));

      // Members — users with at least one assignment on a project issue
      // (open or closed). Aggregate the open-count per user.
      const assigneeRows = issueRows.length
        ? await ctx.db.issueAssignee.findMany({
            where: { issueId: { in: issueRows.map((r) => r.id) } },
            include: {
              user: { select: { id: true, name: true, handle: true, image: true } },
              issue: { select: { id: true, status: { select: { category: true } } } },
            },
          })
        : [];
      const memberMap = new Map<
        string,
        {
          userId: string;
          name: string | null;
          handle: string | null;
          avatarUrl: string | null;
          openCount: number;
        }
      >();
      for (const row of assigneeRows) {
        if (!row.user) continue;
        const cat = row.issue?.status.category;
        const open = cat !== "DONE" && cat !== "CANCELED";
        const existing = memberMap.get(row.user.id);
        if (existing) {
          if (open) existing.openCount += 1;
        } else {
          memberMap.set(row.user.id, {
            userId: row.user.id,
            name: row.user.name,
            handle: row.user.handle,
            avatarUrl: row.user.image,
            openCount: open ? 1 : 0,
          });
        }
      }
      const members = Array.from(memberMap.values()).sort(
        (a, b) => b.openCount - a.openCount,
      );

      return {
        project: {
          id: project.id,
          key: project.key,
          name: project.name,
          description: project.description,
          color: project.color,
          icon: project.icon,
          archived: project.archived,
          startDate: project.startDate,
          targetDate: project.targetDate,
          initiativeId: project.initiativeId,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        },
        counts,
        currentCycleSlice,
        linkedInitiative,
        recentActivity,
        members,
      };
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
