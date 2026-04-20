import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CycleStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

/**
 * Cycles — time-boxed iterations that group in-flight issues.
 *
 * Defaults cascade from the workspace row (`cycleLengthDays`,
 * `cycleCooldownDays`) so admins can tune iteration cadence per workspace
 * without editing handler code. Individual cycles still store their own
 * length so history remains accurate if the workspace default changes later.
 */

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

export const listInput = z.object({
  status: z.nativeEnum(CycleStatus).optional(),
});

export const getInput = z.object({
  id: z.string().cuid(),
});

export const createInput = z.object({
  name: z.string().min(1).max(80),
  startsAt: z.date().optional(),
  endsAt: z.date().optional(),
  lengthDays: z.number().int().min(1).max(365).optional(),
  cooldownDays: z.number().int().min(0).max(90).optional(),
});

export const updateInput = z.object({
  id: z.string().cuid(),
  name: z.string().min(1).max(80).optional(),
  startsAt: z.date().optional(),
  endsAt: z.date().optional(),
  status: z.nativeEnum(CycleStatus).optional(),
});

export const archiveInput = z.object({
  id: z.string().cuid(),
});

export const planInput = z.object({
  cycleId: z.string().cuid(),
  issueIds: z.array(z.string().cuid()).min(1).max(500),
});

export const rolloverInput = z.object({
  fromCycleId: z.string().cuid(),
});

export const cycleRouter = router({
  list: workspaceProcedure
    .input(listInput.default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db.cycle.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: { startsAt: "desc" },
        include: { _count: { select: { issues: true } } },
      });
    }),

  get: workspaceProcedure.input(getInput).query(async ({ ctx, input }) => {
    const cycle = await ctx.db.cycle.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      include: {
        issues: {
          where: { deletedAt: null },
          include: { status: true },
          orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!cycle) throw new TRPCError({ code: "NOT_FOUND" });
    return cycle;
  }),

  current: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.cycle.findFirst({
      where: { workspaceId: ctx.workspaceId, status: CycleStatus.ACTIVE },
      orderBy: { startsAt: "desc" },
    });
  }),

  create: workspaceProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const workspace = await ctx.db.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { cycleLengthDays: true, cycleCooldownDays: true },
    });
    const lengthDays = input.lengthDays ?? workspace.cycleLengthDays;
    const cooldownDays = input.cooldownDays ?? workspace.cycleCooldownDays;
    const startsAt = input.startsAt ?? new Date();
    const endsAt = input.endsAt ?? addDays(startsAt, lengthDays);

    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Cycle `endsAt` must be after `startsAt`.",
      });
    }

    return ctx.db.$transaction(async (tx) => {
      const cycle = await tx.cycle.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          startsAt,
          endsAt,
          lengthDays,
          cooldownDays,
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "Cycle",
        entityId: cycle.id,
        action: "create",
        after: cycle,
        eventKind: EventKind.PROJECT_CREATED,
        subjectType: "cycle",
        subjectId: cycle.id,
        payload: { name: cycle.name },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return cycle;
    });
  }),

  update: workspaceProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const { id, ...patch } = input;
    return ctx.db.$transaction(async (tx) => {
      const before = await tx.cycle.findFirstOrThrow({
        where: { id, workspaceId: ctx.workspaceId },
      });
      const after = await tx.cycle.update({ where: { id }, data: patch });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "Cycle",
        entityId: id,
        action: "update",
        before,
        after,
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "cycle",
        subjectId: id,
        payload: patch,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }),

  archive: workspaceProcedure.input(archiveInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const before = await tx.cycle.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      const after = await tx.cycle.update({
        where: { id: input.id },
        data: { status: CycleStatus.COMPLETED },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        entity: "Cycle",
        entityId: input.id,
        action: "archive",
        before,
        after,
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "cycle",
        subjectId: input.id,
        payload: { status: CycleStatus.COMPLETED },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return after;
    });
  }),

  /**
   * Bulk-assign issues to a cycle. Records one ISSUE_UPDATED event per
   * moved issue — mirrors how single-issue updates are audited so plugins
   * and SSE consumers see a uniform stream.
   */
  plan: workspaceProcedure.input(planInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const cycle = await tx.cycle.findFirstOrThrow({
        where: { id: input.cycleId, workspaceId: ctx.workspaceId },
      });
      const issues = await tx.issue.findMany({
        where: {
          id: { in: input.issueIds },
          workspaceId: ctx.workspaceId,
          deletedAt: null,
        },
        select: { id: true, cycleId: true },
      });
      if (issues.length !== input.issueIds.length) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "One or more issues were not found in this workspace.",
        });
      }
      await tx.issue.updateMany({
        where: { id: { in: issues.map((i) => i.id) }, workspaceId: ctx.workspaceId },
        data: { cycleId: cycle.id },
      });
      for (const issue of issues) {
        if (issue.cycleId === cycle.id) continue;
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: issue.id,
          action: "cycle.plan",
          before: { cycleId: issue.cycleId },
          after: { cycleId: cycle.id },
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "issue",
          subjectId: issue.id,
          payload: { cycleId: cycle.id },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
      return { planned: issues.length, cycleId: cycle.id };
    });
  }),

  /**
   * Move every unfinished issue from `fromCycleId` into the next ACTIVE
   * cycle. If no ACTIVE cycle exists we create one using the workspace
   * defaults — keeps the operator flow single-click.
   */
  rollover: workspaceProcedure.input(rolloverInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const fromCycle = await tx.cycle.findFirstOrThrow({
        where: { id: input.fromCycleId, workspaceId: ctx.workspaceId },
      });

      const unfinished = await tx.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          cycleId: fromCycle.id,
          deletedAt: null,
          status: { category: { notIn: ["DONE", "CANCELED"] } },
        },
        select: { id: true, cycleId: true },
      });

      let targetCycle = await tx.cycle.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          status: CycleStatus.ACTIVE,
          id: { not: fromCycle.id },
        },
        orderBy: { startsAt: "asc" },
      });

      if (!targetCycle) {
        const workspace = await tx.workspace.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: { cycleLengthDays: true, cycleCooldownDays: true },
        });
        const startsAt = addDays(fromCycle.endsAt, workspace.cycleCooldownDays);
        const endsAt = addDays(startsAt, workspace.cycleLengthDays);
        targetCycle = await tx.cycle.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: `${fromCycle.name} (rollover)`,
            startsAt,
            endsAt,
            lengthDays: workspace.cycleLengthDays,
            cooldownDays: workspace.cycleCooldownDays,
            status: CycleStatus.ACTIVE,
          },
        });
      }

      if (unfinished.length) {
        await tx.issue.updateMany({
          where: { id: { in: unfinished.map((i) => i.id) }, workspaceId: ctx.workspaceId },
          data: { cycleId: targetCycle.id },
        });
        for (const issue of unfinished) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            entity: "Issue",
            entityId: issue.id,
            action: "cycle.rollover",
            before: { cycleId: issue.cycleId },
            after: { cycleId: targetCycle.id },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: { cycleId: targetCycle.id, fromCycleId: fromCycle.id },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
      }

      return { rolled: unfinished.length, targetCycleId: targetCycle.id };
    });
  }),
});
