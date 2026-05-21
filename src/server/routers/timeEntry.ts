import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

/**
 * Time tracking — per-user, workspace-scoped duration rows.
 *
 * Invariants:
 *   • at most one running entry (endedAt IS NULL) per user per workspace
 *   • `billable` + `hourlyRate` drive amount calculations; we never persist
 *     the computed amount, only the inputs, so rate changes can be applied
 *     retroactively if needed.
 */

const startInput = z.object({
  issueId: z.string().cuid().optional(),
  description: z.string().max(1000).optional(),
  billable: z.boolean().default(false),
  hourlyRate: z.number().min(0).max(10_000).optional(),
});

const stopInput = z.object({ entryId: z.string().cuid() });

const listInput = z
  .object({
    userId: z.string().cuid().optional(),
    issueId: z.string().cuid().optional(),
    from: z.date().optional(),
    to: z.date().optional(),
    billable: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .default({ limit: 100 });

const updateInput = z.object({
  entryId: z.string().cuid(),
  description: z.string().max(1000).nullable().optional(),
  billable: z.boolean().optional(),
  hourlyRate: z.number().min(0).max(10_000).nullable().optional(),
  startedAt: z.date().optional(),
  endedAt: z.date().nullable().optional(),
});

const deleteInput = z.object({ entryId: z.string().cuid() });

const summaryInput = z.object({
  from: z.date(),
  to: z.date(),
  groupBy: z.enum(["day", "issue", "project", "billable"]),
  userId: z.string().cuid().optional(),
});

const exportCsvInput = z.object({
  from: z.date(),
  to: z.date(),
  userId: z.string().cuid().optional(),
});

export {
  startInput as timeEntryStartInput,
  stopInput as timeEntryStopInput,
  listInput as timeEntryListInput,
  updateInput as timeEntryUpdateInput,
  deleteInput as timeEntryDeleteInput,
  summaryInput as timeEntrySummaryInput,
  exportCsvInput as timeEntryExportCsvInput,
};

function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

function amountFor(minutes: number, rate: number | null | undefined): number {
  if (!rate) return 0;
  return Math.round((minutes / 60) * rate * 100) / 100;
}

function dayKey(date: Date): string {
  // ISO date (UTC) — stable bucket key regardless of server TZ.
  return date.toISOString().slice(0, 10);
}

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const timeEntryRouter = router({
  start: workspaceProcedure.input(startInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const running = await tx.timeEntry.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          endedAt: null,
        },
      });
      if (running) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "You already have a running time entry. Stop it before starting a new one.",
        });
      }

      if (input.issueId) {
        const issue = await tx.issue.findFirst({
          where: { id: input.issueId, workspaceId: ctx.workspaceId, deletedAt: null },
          select: { id: true },
        });
        if (!issue) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Issue not found in workspace." });
        }
      }

      const entry = await tx.timeEntry.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          issueId: input.issueId,
          description: input.description,
          startedAt: new Date(),
          billable: input.billable,
          hourlyRate: input.hourlyRate,
        },
      });

      if (input.issueId) {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "TimeEntry",
          entityId: entry.id,
          action: "start",
          after: entry,
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "issue",
          subjectId: input.issueId,
          payload: { timeEntryId: entry.id, event: "time.start" },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }

      return entry;
    });
  }),

  stop: workspaceProcedure.input(stopInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const entry = await tx.timeEntry.findFirst({
        where: {
          id: input.entryId,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!entry) throw new TRPCError({ code: "NOT_FOUND" });
      if (entry.endedAt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Entry is already stopped." });
      }

      const stopped = await tx.timeEntry.update({
        where: { id: entry.id },
        data: { endedAt: new Date() },
      });

      if (stopped.issueId) {
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "TimeEntry",
          entityId: stopped.id,
          action: "stop",
          before: entry,
          after: stopped,
          eventKind: EventKind.ISSUE_UPDATED,
          subjectType: "issue",
          subjectId: stopped.issueId,
          payload: {
            timeEntryId: stopped.id,
            event: "time.stop",
            minutes: stopped.endedAt ? minutesBetween(stopped.startedAt, stopped.endedAt) : 0,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }

      return stopped;
    });
  }),

  running: workspaceProcedure.query(async ({ ctx }) => {
    return ctx.db.timeEntry.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        endedAt: null,
      },
      include: {
        issue: {
          select: { id: true, number: true, title: true, projectId: true },
        },
      },
    });
  }),

  list: workspaceProcedure.input(listInput).query(async ({ ctx, input }) => {
    const userId = input.userId ?? ctx.session.user.id;
    const where: Prisma.TimeEntryWhereInput = {
      workspaceId: ctx.workspaceId,
      userId,
      ...(input.issueId ? { issueId: input.issueId } : {}),
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
      ...(input.from || input.to
        ? {
            startedAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
    };
    return ctx.db.timeEntry.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: input.limit,
      include: {
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            projectId: true,
            project: { select: { id: true, key: true, name: true } },
          },
        },
      },
    });
  }),

  update: workspaceProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const { entryId, ...patch } = input;
    return ctx.db.$transaction(async (tx) => {
      const entry = await tx.timeEntry.findFirst({
        where: {
          id: entryId,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!entry) throw new TRPCError({ code: "NOT_FOUND" });
      return tx.timeEntry.update({ where: { id: entry.id }, data: patch });
    });
  }),

  delete: workspaceProcedure.input(deleteInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const entry = await tx.timeEntry.findFirst({
        where: {
          id: input.entryId,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!entry) throw new TRPCError({ code: "NOT_FOUND" });
      await tx.timeEntry.delete({ where: { id: entry.id } });
      return { ok: true };
    });
  }),

  summary: workspaceProcedure.input(summaryInput).query(async ({ ctx, input }) => {
    const userId = input.userId ?? ctx.session.user.id;
    const entries = await ctx.db.timeEntry.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        userId,
        startedAt: { gte: input.from, lte: input.to },
        endedAt: { not: null },
      },
      include: {
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            projectId: true,
            project: { select: { id: true, key: true, name: true } },
          },
        },
      },
    });

    const buckets = new Map<string, { key: string; minutes: number; billableAmount: number }>();
    let totalMinutes = 0;
    let totalBillableAmount = 0;

    for (const e of entries) {
      if (!e.endedAt) continue;
      const minutes = minutesBetween(e.startedAt, e.endedAt);
      const amount = e.billable ? amountFor(minutes, e.hourlyRate) : 0;
      totalMinutes += minutes;
      totalBillableAmount += amount;

      let key: string;
      if (input.groupBy === "day") key = dayKey(e.startedAt);
      else if (input.groupBy === "issue") key = e.issue?.id ?? "unassigned";
      else if (input.groupBy === "project") key = e.issue?.project?.id ?? "unassigned";
      else key = e.billable ? "billable" : "non-billable";

      const bucket = buckets.get(key) ?? { key, minutes: 0, billableAmount: 0 };
      bucket.minutes += minutes;
      bucket.billableAmount += amount;
      buckets.set(key, bucket);
    }

    const list = Array.from(buckets.values()).sort((a, b) => b.minutes - a.minutes);
    return {
      totalMinutes,
      totalBillableAmount: Math.round(totalBillableAmount * 100) / 100,
      buckets: list,
    };
  }),

  exportCsv: workspaceProcedure.input(exportCsvInput).query(async ({ ctx, input }) => {
    const userId = input.userId ?? ctx.session.user.id;
    const entries = await ctx.db.timeEntry.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        userId,
        startedAt: { gte: input.from, lte: input.to },
      },
      include: {
        issue: {
          select: {
            id: true,
            number: true,
            title: true,
            project: { select: { key: true, name: true } },
            workspace: { select: { key: true } },
          },
        },
      },
      orderBy: { startedAt: "asc" },
    });

    const header = [
      "date",
      "issueKey",
      "issueTitle",
      "projectKey",
      "description",
      "startedAt",
      "endedAt",
      "minutes",
      "billable",
      "hourlyRate",
      "amount",
    ].join(",");

    const rows = entries.map((e) => {
      const minutes = e.endedAt ? minutesBetween(e.startedAt, e.endedAt) : 0;
      const amount = e.billable && e.endedAt ? amountFor(minutes, e.hourlyRate) : 0;
      const issueKey = e.issue
        ? `${e.issue.workspace.key}-${e.issue.number}`
        : "";
      return [
        dayKey(e.startedAt),
        issueKey,
        e.issue?.title ?? "",
        e.issue?.project?.key ?? "",
        e.description ?? "",
        e.startedAt.toISOString(),
        e.endedAt ? e.endedAt.toISOString() : "",
        minutes,
        e.billable ? "true" : "false",
        e.hourlyRate ?? "",
        amount,
      ]
        .map(csvEscape)
        .join(",");
    });

    return [header, ...rows].join("\n") + "\n";
  }),
});
