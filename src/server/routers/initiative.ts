import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { InitiativeStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import {
  assertProjectAction,
  buildIssueAccessWhere,
  buildProjectAccessWhere,
} from "@/server/services/authorization";

/**
 * Initiatives — umbrella containers above projects. An initiative groups
 * multiple projects (and, transitively, issues) under a strategic theme.
 *
 * Slugs are immutable after creation: stable permalinks for docs / keys /
 * external references. Re-slug only via data migration, not via API.
 */

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "initiative";

const slugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.");

export const listInput = z
  .object({
    status: z.nativeEnum(InitiativeStatus).optional(),
  })
  .default({});

export const getInput = z.object({ id: z.string().cuid() });

export const createInput = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema.optional(),
  description: z.string().max(10_000).optional(),
  targetDate: z.date().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export const updateInput = z.object({
  id: z.string().cuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(10_000).nullable().optional(),
  targetDate: z.date().nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  status: z.nativeEnum(InitiativeStatus).optional(),
});

export const reorderInput = z.object({
  ids: z.array(z.string().cuid()).min(1).max(500),
});

export const archiveInput = z.object({ id: z.string().cuid() });

export const linkProjectInput = z.object({
  initiativeId: z.string().cuid(),
  projectId: z.string().cuid(),
});

export const unlinkProjectInput = z.object({
  projectId: z.string().cuid(),
});

export const initiativeRouter = router({
  list: workspaceProcedure.input(listInput).query(async ({ ctx, input }) => {
    const projectAccess = buildProjectAccessWhere({
      workspaceId: ctx.workspaceId,
      membershipId: ctx.membership.id,
      membershipRole: ctx.membership.role,
      action: "READ",
    });
    const initiatives = await ctx.db.initiative.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: {
        _count: { select: { projects: true } },
        projects: {
          where: { ...projectAccess, deletedAt: null },
          orderBy: { updatedAt: "desc" },
          select: { id: true, key: true, name: true, color: true },
        },
      },
    });
    if (initiatives.length === 0) return [];

    // Roll up issue counts per initiative in a single grouped query
    // (replaces the per-card `issue.list` N+1 the old card was doing).
    // We aggregate by `project.initiativeId` and split into total vs.
    // done/canceled buckets so the card can render `done/total · pct`
    // without a second roundtrip.
    const grouped = await ctx.db.issue.groupBy({
      by: ["projectId", "statusId"],
      where: {
        ...buildIssueAccessWhere({
          workspaceId: ctx.workspaceId,
          membershipId: ctx.membership.id,
          membershipRole: ctx.membership.role,
          action: "READ",
        }),
        project: {
          ...projectAccess,
          initiativeId: { in: initiatives.map((i) => i.id) },
        },
      },
      _count: { _all: true },
    });

    // Resolve project → initiative + status → terminal-or-not in one go.
    const projectIds = Array.from(
      new Set(grouped.map((g) => g.projectId).filter(Boolean) as string[]),
    );
    const projects = projectIds.length
      ? await ctx.db.project.findMany({
          where: { id: { in: projectIds }, ...projectAccess },
          select: { id: true, initiativeId: true },
        })
      : [];
    const projectInitiative = new Map(
      projects.map((p) => [p.id, p.initiativeId] as const),
    );

    const statusIds = Array.from(new Set(grouped.map((g) => g.statusId)));
    const statuses = statusIds.length
      ? await ctx.db.status.findMany({
          where: { id: { in: statusIds }, workspaceId: ctx.workspaceId },
          select: { id: true, category: true },
        })
      : [];
    const isTerminal = new Map(
      statuses.map(
        (s) => [s.id, s.category === "DONE" || s.category === "CANCELED"] as const,
      ),
    );

    const totals = new Map<string, { total: number; done: number }>();
    // Per-project tally, reusing the same grouped rows + isTerminal map.
    const projectTally = new Map<string, { total: number; done: number }>();
    for (const row of grouped) {
      if (!row.projectId) continue;
      const pCell = projectTally.get(row.projectId) ?? { total: 0, done: 0 };
      pCell.total += row._count._all;
      if (isTerminal.get(row.statusId)) pCell.done += row._count._all;
      projectTally.set(row.projectId, pCell);

      const initiativeId = projectInitiative.get(row.projectId);
      if (!initiativeId) continue;
      const cell = totals.get(initiativeId) ?? { total: 0, done: 0 };
      cell.total += row._count._all;
      if (isTerminal.get(row.statusId)) cell.done += row._count._all;
      totals.set(initiativeId, cell);
    }

    return initiatives.map((i) => {
      const t = totals.get(i.id) ?? { total: 0, done: 0 };
      return {
        ...i,
        projects: i.projects.map((p) => {
          const pt = projectTally.get(p.id) ?? { total: 0, done: 0 };
          return { ...p, done: pt.done, total: pt.total };
        }),
        _count: {
          ...i._count,
          issues: t.total,
          doneIssues: t.done,
        },
      };
    });
  }),

  get: workspaceProcedure.input(getInput).query(async ({ ctx, input }) => {
    const initiative = await ctx.db.initiative.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      include: {
        projects: {
          where: {
            ...buildProjectAccessWhere({
              workspaceId: ctx.workspaceId,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
              action: "READ",
            }),
            deletedAt: null,
          },
          orderBy: { updatedAt: "desc" },
        },
      },
    });
    if (!initiative) throw new TRPCError({ code: "NOT_FOUND" });
    return initiative;
  }),

  /**
   * Narrow "card-shape" summary used by the initiative chip hover
   * preview. Looks up an initiative by either `id` or `slug` (chips
   * carry slug for the click-through). Workspace-scoped.
   *
   * Counts: linked (non-deleted) projects + open issues across all
   * linked projects (status category not in DONE / CANCELED). Both
   * are tallied in a single roundtrip each so the popover renders
   * without follow-up fetches.
   */
  summary: workspaceProcedure
    .input(
      z
        .object({
          id: z.string().cuid().optional(),
          slug: slugSchema.optional(),
        })
        .refine((v) => v.id || v.slug, {
          message: "Provide id or slug.",
        }),
    )
    .query(async ({ ctx, input }) => {
      const initiative = await ctx.db.initiative.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.id ? { id: input.id } : {}),
          ...(input.slug ? { slug: input.slug } : {}),
        },
        select: {
          id: true,
          slug: true,
          name: true,
          color: true,
          status: true,
          targetDate: true,
          createdById: true,
        },
      });
      if (!initiative) throw new TRPCError({ code: "NOT_FOUND" });

      // Initiative has no Prisma relation back to User (only the FK
      // column), so resolve the creator separately. Cheap one-shot.
      const [createdBy, projectCount, activeIssueCount] = await Promise.all([
        initiative.createdById
          ? ctx.db.user.findUnique({
              where: { id: initiative.createdById },
              select: { id: true, name: true, image: true },
            })
          : Promise.resolve(null),
        ctx.db.project.count({
          where: {
            ...buildProjectAccessWhere({
              workspaceId: ctx.workspaceId,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
              action: "READ",
            }),
            initiativeId: initiative.id,
            deletedAt: null,
          },
        }),
        ctx.db.issue.count({
          where: {
            ...buildIssueAccessWhere({
              workspaceId: ctx.workspaceId,
              membershipId: ctx.membership.id,
              membershipRole: ctx.membership.role,
              action: "READ",
            }),
            project: { initiativeId: initiative.id, deletedAt: null },
            status: { category: { notIn: ["DONE", "CANCELED"] } },
          },
        }),
      ]);

      return {
        ...initiative,
        createdBy,
        projectCount,
        activeIssueCount,
      };
    }),

  create: workspaceProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const slug = input.slug ?? slugify(input.name);
    return ctx.db.$transaction(async (tx) => {
      const existing = await tx.initiative.findUnique({
        where: { workspaceId_slug: { workspaceId: ctx.workspaceId, slug } },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Initiative slug "${slug}" is already in use.`,
        });
      }

      // New initiatives land at the end of the list.
      const last = await tx.initiative.findFirst({
        where: { workspaceId: ctx.workspaceId },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      const initiative = await tx.initiative.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          slug,
          description: input.description,
          targetDate: input.targetDate,
          color: input.color,
          position: (last?.position ?? -1) + 1,
          createdById: ctx.session.user.id,
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Initiative",
        entityId: initiative.id,
        action: "create",
        after: initiative,
        eventKind: EventKind.PROJECT_CREATED,
        subjectType: "initiative",
        subjectId: initiative.id,
        payload: { name: initiative.name, slug: initiative.slug },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return initiative;
    });
  }),

  update: workspaceProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const { id, ...patch } = input;
    return ctx.db.$transaction(async (tx) => {
      const before = await tx.initiative.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      const after = await tx.initiative.update({ where: { id }, data: patch });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Initiative",
        entityId: id,
        action: "update",
        before,
        after,
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "initiative",
        subjectId: id,
        payload: patch,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }),

  reorder: workspaceProcedure.input(reorderInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      // Validate every id belongs to this workspace before touching anything.
      const found = await tx.initiative.findMany({
        where: { id: { in: input.ids }, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (found.length !== input.ids.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "One or more initiatives were not found in this workspace.",
        });
      }
      for (let i = 0; i < input.ids.length; i++) {
        await tx.initiative.update({
          where: { id: input.ids[i]! },
          data: { position: i },
        });
      }
      return { ok: true, count: input.ids.length };
    });
  }),

  archive: workspaceProcedure.input(archiveInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const before = await tx.initiative.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      const after = await tx.initiative.update({
        where: { id: input.id },
        data: { status: InitiativeStatus.COMPLETED },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Initiative",
        entityId: input.id,
        action: "archive",
        before,
        after,
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "initiative",
        subjectId: input.id,
        payload: { status: InitiativeStatus.COMPLETED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }),

  linkProject: workspaceProcedure.input(linkProjectInput).mutation(async ({ ctx, input }) => {
    await assertProjectAction(ctx.db, {
      projectId: input.projectId,
      workspaceId: ctx.workspaceId,
      membershipId: ctx.membership.id,
      membershipRole: ctx.membership.role,
      action: "MANAGE",
    });
    return ctx.db.$transaction(async (tx) => {
      const initiative = await tx.initiative.findFirstOrThrow({
        where: { id: input.initiativeId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      const before = await tx.project.findFirstOrThrow({
        where: { id: input.projectId, workspaceId: ctx.workspaceId },
      });
      const after = await tx.project.update({
        where: { id: input.projectId },
        data: { initiativeId: initiative.id },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Project",
        entityId: input.projectId,
        action: "initiative.link",
        before: { initiativeId: before.initiativeId },
        after: { initiativeId: initiative.id },
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "project",
        subjectId: input.projectId,
        payload: { initiativeId: initiative.id },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }),

  /**
   * Counterpart to `initiative.get(id)`'s `projects[]`: given a project id,
   * return the linked initiative (if any). Phase 1 uses this to render an
   * `InitiativeChip` on the project detail page without having to load the
   * full initiative tree. Tenant-scoped — cross-workspace lookups return
   * null rather than throwing.
   */
  linkedFor: workspaceProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { initiativeId: true },
      });
      if (!project || !project.initiativeId) return { initiative: null };
      const initiative = await ctx.db.initiative.findFirst({
        where: { id: project.initiativeId, workspaceId: ctx.workspaceId },
        select: { id: true, slug: true, name: true, status: true },
      });
      return { initiative: initiative ?? null };
    }),

  unlinkProject: workspaceProcedure.input(unlinkProjectInput).mutation(async ({ ctx, input }) => {
    await assertProjectAction(ctx.db, {
      projectId: input.projectId,
      workspaceId: ctx.workspaceId,
      membershipId: ctx.membership.id,
      membershipRole: ctx.membership.role,
      action: "MANAGE",
    });
    return ctx.db.$transaction(async (tx) => {
      const before = await tx.project.findFirstOrThrow({
        where: { id: input.projectId, workspaceId: ctx.workspaceId },
      });
      const after = await tx.project.update({
        where: { id: input.projectId },
        data: { initiativeId: null },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Project",
        entityId: input.projectId,
        action: "initiative.unlink",
        before: { initiativeId: before.initiativeId },
        after: { initiativeId: null },
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "project",
        subjectId: input.projectId,
        payload: { initiativeId: null },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }),
});
