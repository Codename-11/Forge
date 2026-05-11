import "server-only";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";

/**
 * Instantiate a single RecurringIssue row — create the actual Issue + bump
 * `nextRunAt`. Used by both the scheduler tick and the `runNow` tRPC proc.
 */
export async function runRecurringOnce(recurringId: string) {
  return db.$transaction(async (tx) => {
    const row = await tx.recurringIssue.findUnique({ where: { id: recurringId } });
    if (!row || !row.active) return null;

    const status = await tx.status.findFirstOrThrow({
      where: { workspaceId: row.workspaceId, isDefault: true },
    });
    const last = await tx.issue.findFirst({
      where: { workspaceId: row.workspaceId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const issue = await tx.issue.create({
      data: {
        workspaceId: row.workspaceId,
        number: (last?.number ?? 0) + 1,
        title: row.titleTemplate,
        description: row.descriptionTemplate,
        projectId: row.projectId,
        statusId: status.id,
        priority: row.defaultPriority,
        authorId: row.createdById,
      },
      include: { status: true },
    });

    await recordChange(tx, {
      workspaceId: row.workspaceId,
      actorId: row.createdById,
      entity: "Issue",
      entityId: issue.id,
      action: "create",
      after: issue,
      eventKind: EventKind.ISSUE_CREATED,
      subjectType: "issue",
      subjectId: issue.id,
      payload: { source: "recurring", recurringId: row.id },
    });

    await tx.recurringIssue.update({
      where: { id: row.id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + row.intervalDays * 86_400_000),
      },
    });
    return issue;
  });
}

let tickerStarted = false;
let _tickerHandle: NodeJS.Timeout | null = null;

/**
 * Scan all due RecurringIssue rows and materialize issues for each. Safe to
 * call concurrently (per-row transactions).
 */
export async function scanDueRecurring() {
  const now = new Date();
  const due = await db.recurringIssue.findMany({
    where: { active: true, nextRunAt: { lte: now } },
    select: { id: true },
    take: 50,
  });
  if (!due.length) return 0;
  let created = 0;
  for (const r of due) {
    try {
      const res = await runRecurringOnce(r.id);
      if (res) created += 1;
    } catch (err) {
      logger.warn({ err, recurringId: r.id }, "recurring run failed");
    }
  }
  if (created) logger.info({ created }, "recurring tick created issues");
  return created;
}

/**
 * Start the in-process ticker. Runs on Next.js server boot via dynamic
 * import from `instrumentation.ts`. Guarded against dev hot-reload.
 */
export function startRecurringTicker(intervalMs = 5 * 60_000) {
  if (tickerStarted) return;
  tickerStarted = true;
  // Fire once shortly after boot so a manual `runNow` after creation isn't
  // the only way to see it work.
  _tickerHandle = setTimeout(async function tick() {
    try {
      await scanDueRecurring();
    } catch (err) {
      logger.warn({ err }, "recurring tick errored");
    } finally {
      _tickerHandle = setTimeout(tick, intervalMs);
    }
  }, 10_000);
  logger.info({ intervalMs }, "recurring ticker started");
}
