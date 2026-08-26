import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { CycleStatus, EventKind } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { buildIssueAccessWhere } from "@/server/services/authorization";

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

const MS_PER_DAY = 86_400_000;

const daysBetween = (start: Date, end: Date): number =>
  Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));

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
  status: z.nativeEnum(CycleStatus).optional(),
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

export const deleteInput = z.object({
  id: z.string().cuid(),
});

export const planInput = z.object({
  cycleId: z.string().cuid(),
  issueIds: z.array(z.string().cuid()).min(1).max(500),
});

export const rolloverInput = z.object({
  fromCycleId: z.string().cuid(),
  completeSource: z.boolean().optional().default(false),
  activateTarget: z.boolean().optional().default(false),
});

async function assertNoOtherActiveCycle(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  currentCycleId?: string,
) {
  const existing = await tx.cycle.findFirst({
    where: {
      workspaceId,
      status: CycleStatus.ACTIVE,
      ...(currentCycleId ? { id: { not: currentCycleId } } : {}),
    },
    select: { name: true },
  });
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Sprint "${existing.name}" is already active. Complete it before starting another sprint.`,
    });
  }
}

export const cycleRouter = router({
  list: workspaceProcedure.input(listInput.default({})).query(async ({ ctx, input }) => {
    const issueAccess = buildIssueAccessWhere({
      workspaceId: ctx.workspaceId,
      membershipId: ctx.membership.id,
      membershipRole: ctx.membership.role,
      action: "READ",
    });
    return ctx.db.cycle.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: { startsAt: "desc" },
      include: { _count: { select: { issues: { where: issueAccess } } } },
    });
  }),

  get: workspaceProcedure.input(getInput).query(async ({ ctx, input }) => {
    const cycle = await ctx.db.cycle.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      include: {
        issues: {
          where: buildIssueAccessWhere({
            workspaceId: ctx.workspaceId,
            membershipId: ctx.membership.id,
            membershipRole: ctx.membership.role,
            action: "READ",
          }),
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

  /**
   * Narrow "card-shape" summary used by the cycle chip hover preview.
   * Workspace-scoped lookup by id. Returns the cycle plus three issue
   * counts (planned = backlog/todo, inFlight = in-progress/in-review,
   * done = done/canceled) so the popover can render a progress bar
   * without a follow-up fetch.
   *
   * UI nomenclature: cycles are surfaced as "Sprint" in display strings;
   * data model + procedure name stays `cycle`.
   */
  summary: workspaceProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const cycle = await ctx.db.cycle.findFirst({
        where: { id: input.id, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          name: true,
          status: true,
          startsAt: true,
          endsAt: true,
          lengthDays: true,
        },
      });
      if (!cycle) throw new TRPCError({ code: "NOT_FOUND" });

      // Bucket the cycle's issues by status category in one round-trip.
      const rows = await ctx.db.issue.findMany({
        where: {
          ...buildIssueAccessWhere({
            workspaceId: ctx.workspaceId,
            membershipId: ctx.membership.id,
            membershipRole: ctx.membership.role,
            action: "READ",
          }),
          cycleId: cycle.id,
        },
        select: { status: { select: { category: true } } },
      });
      const counts = { planned: 0, inFlight: 0, done: 0 };
      for (const r of rows) {
        const cat = r.status.category;
        if (cat === "BACKLOG" || cat === "TODO") counts.planned += 1;
        else if (cat === "IN_PROGRESS" || cat === "IN_REVIEW") {
          counts.inFlight += 1;
        } else if (cat === "DONE" || cat === "CANCELED") counts.done += 1;
      }

      return {
        ...cycle,
        total: rows.length,
        counts,
      };
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
      if (input.status === CycleStatus.ACTIVE) {
        await assertNoOtherActiveCycle(tx, ctx.workspaceId);
      }

      const cycle = await tx.cycle.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: input.name,
          startsAt,
          endsAt,
          lengthDays,
          cooldownDays,
          status: input.status,
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
      if (patch.status === CycleStatus.ACTIVE && before.status !== CycleStatus.ACTIVE) {
        await assertNoOtherActiveCycle(tx, ctx.workspaceId, id);
      }

      const startsAt = patch.startsAt ?? before.startsAt;
      const endsAt = patch.endsAt ?? before.endsAt;
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cycle `endsAt` must be after `startsAt`.",
        });
      }

      const after = await tx.cycle.update({
        where: { id },
        data: {
          ...patch,
          ...((patch.startsAt || patch.endsAt) && {
            lengthDays: daysBetween(startsAt, endsAt),
          }),
        },
      });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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

  delete: workspaceProcedure.input(deleteInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const before = await tx.cycle.findFirstOrThrow({
        where: { id: input.id, workspaceId: ctx.workspaceId },
      });
      const assignedIssues = await tx.issue.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          cycleId: before.id,
          deletedAt: null,
        },
        select: { id: true, cycleId: true },
      });

      if (assignedIssues.length) {
        await tx.issue.updateMany({
          where: {
            id: { in: assignedIssues.map((issue) => issue.id) },
            workspaceId: ctx.workspaceId,
          },
          data: { cycleId: null },
        });
        for (const issue of assignedIssues) {
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "cycle.clear",
            before: { cycleId: issue.cycleId },
            after: { cycleId: null },
            eventKind: EventKind.ISSUE_UPDATED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: { cycleId: null, deletedCycleId: before.id },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
      }

      await tx.cycle.delete({ where: { id: before.id } });
      await recordChange(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.session.user.id,
        actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
        entity: "Cycle",
        entityId: before.id,
        action: "delete",
        before,
        eventKind: EventKind.PROJECT_UPDATED,
        subjectType: "cycle",
        subjectId: before.id,
        payload: { name: before.name, clearedIssueCount: assignedIssues.length },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { deletedId: before.id, clearedIssueCount: assignedIssues.length };
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
          ...buildIssueAccessWhere({
            workspaceId: ctx.workspaceId,
            membershipId: ctx.membership.id,
            membershipRole: ctx.membership.role,
            action: "CONTRIBUTE",
          }),
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
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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
   * Move every unfinished issue from `fromCycleId` into the next planned
   * sprint. Callers choose whether to also complete the source sprint and
   * whether the target should become active. Activating the target enforces
   * the workspace invariant that only one sprint can be ACTIVE at a time.
   */
  rollover: workspaceProcedure.input(rolloverInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const fromCycle = await tx.cycle.findFirstOrThrow({
        where: { id: input.fromCycleId, workspaceId: ctx.workspaceId },
      });
      const shouldActivateTarget = input.activateTarget;
      const shouldCompleteSource = input.completeSource || shouldActivateTarget;

      if (shouldActivateTarget) {
        await assertNoOtherActiveCycle(tx, ctx.workspaceId, fromCycle.id);
      }

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
          status: CycleStatus.PLANNED,
          id: { not: fromCycle.id },
          startsAt: { gte: fromCycle.endsAt },
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
            status: shouldActivateTarget ? CycleStatus.ACTIVE : CycleStatus.PLANNED,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Cycle",
          entityId: targetCycle.id,
          action: "create",
          after: targetCycle,
          eventKind: EventKind.PROJECT_CREATED,
          subjectType: "cycle",
          subjectId: targetCycle.id,
          payload: {
            name: targetCycle.name,
            fromCycleId: fromCycle.id,
            source: "rollover",
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      } else if (shouldActivateTarget && targetCycle.status !== CycleStatus.ACTIVE) {
        const before = targetCycle;
        targetCycle = await tx.cycle.update({
          where: { id: targetCycle.id },
          data: { status: CycleStatus.ACTIVE },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Cycle",
          entityId: targetCycle.id,
          action: "update",
          before,
          after: targetCycle,
          eventKind: EventKind.PROJECT_UPDATED,
          subjectType: "cycle",
          subjectId: targetCycle.id,
          payload: { status: CycleStatus.ACTIVE, source: "rollover" },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
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
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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

      let sourceCompleted = false;
      if (shouldCompleteSource && fromCycle.status !== CycleStatus.COMPLETED) {
        const after = await tx.cycle.update({
          where: { id: fromCycle.id },
          data: { status: CycleStatus.COMPLETED },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Cycle",
          entityId: fromCycle.id,
          action: "update",
          before: fromCycle,
          after,
          eventKind: EventKind.PROJECT_UPDATED,
          subjectType: "cycle",
          subjectId: fromCycle.id,
          payload: { status: CycleStatus.COMPLETED, source: "rollover" },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        sourceCompleted = true;
      }

      return {
        rolled: unfinished.length,
        targetCycleId: targetCycle.id,
        sourceCompleted,
        targetActivated: targetCycle.status === CycleStatus.ACTIVE,
      };
    });
  }),
});
