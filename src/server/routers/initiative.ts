import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { InitiativeStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

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
    return ctx.db.initiative.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { projects: true } } },
    });
  }),

  get: workspaceProcedure.input(getInput).query(async ({ ctx, input }) => {
    const initiative = await ctx.db.initiative.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      include: {
        projects: {
          where: { deletedAt: null },
          orderBy: { updatedAt: "desc" },
        },
      },
    });
    if (!initiative) throw new TRPCError({ code: "NOT_FOUND" });
    return initiative;
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

  unlinkProject: workspaceProcedure.input(unlinkProjectInput).mutation(async ({ ctx, input }) => {
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
