import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EventKind } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange } from "@/server/audit";
import { coachOnEvent } from "@/server/services/ai-coach";

/**
 * SLA-breach sweep (P1 layer 3 of task follow-through).
 *
 * `Issue.slaMinutes` already exists as a per-issue target. The analytics
 * router has a passive listing of overdue issues but never emits events,
 * so toasts / drawer / agent timeline don't react. This sweep turns the
 * read-only listing into an active enforcement loop: scan all workspaces
 * with `slaEnforcementEnabled = true` and emit `ISSUE_SLA_BREACH` for
 * any non-done issue past its `slaMinutes` cutoff.
 *
 * Idempotent: skip issues that already received an `ISSUE_SLA_BREACH`
 * event in the last 24h, so the 60s cadence doesn't fire repeatedly.
 *
 * Mirrors `stale-work.ts` shape so the maintenance worker can register
 * it identically.
 */

export interface SlaBreachSweepResult {
  workspacesScanned: number;
  breached: string[];
}

const REBREACH_GRACE_MS = 24 * 60 * 60_000;

export async function sweepSlaBreaches(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<SlaBreachSweepResult> {
  const now = new Date();
  const workspaces = await client.workspace.findMany({
    where: { slaEnforcementEnabled: true, deletedAt: null },
    select: { id: true },
  });

  const breached: string[] = [];

  for (const ws of workspaces) {
    const rebreachSince = new Date(now.getTime() - REBREACH_GRACE_MS);

    // Filter on slaMinutes IS NOT NULL plus the non-terminal status
    // categories. `Postgres now() - createdAt > slaMinutes minutes` is
    // expressible in Prisma but the cleanest form is to fetch the
    // candidates and filter in JS — workspace candidate counts are
    // small, and the per-row math gives us the breachedByMinutes value
    // for the payload anyway.
    const candidates = await client.issue.findMany({
      where: {
        workspaceId: ws.id,
        deletedAt: null,
        slaMinutes: { not: null },
        status: { category: { notIn: ["DONE", "CANCELED"] } },
      },
      select: {
        id: true,
        createdAt: true,
        slaMinutes: true,
        priority: true,
      },
    });

    const overdue = candidates.filter((c) => {
      if (c.slaMinutes == null) return false;
      const ageMin = (now.getTime() - c.createdAt.getTime()) / 60_000;
      return ageMin > c.slaMinutes;
    });

    if (!overdue.length) continue;

    const recentBreaches = await client.activityEvent.findMany({
      where: {
        workspaceId: ws.id,
        kind: EventKind.ISSUE_SLA_BREACH,
        subjectType: "issue",
        subjectId: { in: overdue.map((o) => o.id) },
        createdAt: { gte: rebreachSince },
      },
      select: { subjectId: true },
    });
    const recentlyBreached = new Set(recentBreaches.map((e) => e.subjectId));

    for (const issue of overdue) {
      if (recentlyBreached.has(issue.id)) continue;
      if (issue.slaMinutes == null) continue;
      const breachedByMinutes = Math.floor(
        (now.getTime() - issue.createdAt.getTime()) / 60_000 - issue.slaMinutes,
      );

      try {
        await recordChange(client, {
          workspaceId: ws.id,
          actorId: null,
          entity: "Issue",
          entityId: issue.id,
          action: "sla_breach",
          eventKind: EventKind.ISSUE_SLA_BREACH,
          subjectType: "issue",
          subjectId: issue.id,
          payload: {
            slaMinutes: issue.slaMinutes,
            breachedByMinutes,
            priority: issue.priority,
          },
        });
        breached.push(issue.id);
        void coachOnEvent(client, {
          workspaceId: ws.id,
          issueId: issue.id,
          eventKind: "ISSUE_SLA_BREACH",
        });
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, workspaceId: ws.id },
          "sla-breach sweep: audit failed",
        );
      }
    }
  }

  if (breached.length) {
    logger.info(
      { breached: breached.length, workspaces: workspaces.length },
      "sla-breach sweep: issues flagged",
    );
  }

  return {
    workspacesScanned: workspaces.length,
    breached,
  };
}
