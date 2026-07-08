import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { EngagementMode, EventKind } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange } from "@/server/audit";
import { maybeAutoDispatch } from "@/server/services/dispatcher";
import { coachOnEvent } from "@/server/services/ai-coach";

/**
 * Stale-work watchdog (P1 layer 1 of task follow-through).
 *
 * Push-dispatch lands an `AGENT_ASSIGNED` webhook on the agent the moment
 * assignment happens, but Hermes returns 202 immediately — if the LLM
 * call drops mid-thought, nothing notices. The watchdog catches that
 * shape of failure: an issue sitting in BACKLOG/TODO past its workspace
 * `assignmentSlaMinutes` with an agent assigned but no movement.
 *
 * Mode-aware (2026-07-07 fix): "no movement" only means something for an
 * EXECUTE dispatch — per docs/agents/engagement-modes.md, Research/Review/
 * Discuss runs are never supposed to move the issue at all, and posting a
 * reply doesn't touch `Issue.updatedAt` (only a status/field write does).
 * Without this check every non-EXECUTE assignment that outlives the SLA
 * window gets false-flagged regardless of real replies, and — if
 * `autoRedispatchOnStall` is on — the redispatch resets `updatedAt` just
 * long enough to repeat the exact same false stall every SLA window,
 * forever. So a candidate is skipped when its most recent `AgentRun` is
 * anything other than EXECUTE.
 *
 * Per-workspace knobs:
 *   - `assignmentSlaMinutes` — 0 disables; otherwise the cutoff in mins.
 *   - `autoRedispatchOnStall` — when true, also clears `assignedAgentId`
 *     and runs `maybeAutoDispatch` so the next agent picks it up.
 *
 * Idempotent: skips any issue that already received an `ISSUE_STALLED`
 * event in the last hour, so a 60s sweep cadence doesn't fire repeatedly.
 *
 * Scheduled by `src/server/worker.ts` as a repeatable BullMQ job, mirroring
 * the heartbeat-sweep + delivery-drain pattern.
 */

export interface StaleWorkSweepResult {
  workspacesScanned: number;
  stalled: string[];
  redispatched: string[];
}

const RESTALL_GRACE_MS = 60 * 60_000;

export async function sweepStaleWork(
  client: PrismaClient | Prisma.TransactionClient = db,
): Promise<StaleWorkSweepResult> {
  const now = new Date();
  const workspaces = await client.workspace.findMany({
    where: { assignmentSlaMinutes: { gt: 0 }, deletedAt: null },
    select: {
      id: true,
      assignmentSlaMinutes: true,
      autoRedispatchOnStall: true,
    },
  });

  const stalled: string[] = [];
  const redispatched: string[] = [];

  for (const ws of workspaces) {
    const cutoff = new Date(now.getTime() - ws.assignmentSlaMinutes * 60_000);
    const restallSince = new Date(now.getTime() - RESTALL_GRACE_MS);

    const candidates = await client.issue.findMany({
      where: {
        workspaceId: ws.id,
        deletedAt: null,
        assignedAgentId: { not: null },
        updatedAt: { lt: cutoff },
        status: { category: { in: ["BACKLOG", "TODO"] } },
      },
      select: {
        id: true,
        updatedAt: true,
        assignedAgentId: true,
        assignedAgent: { select: { profileKey: true } },
      },
    });

    if (!candidates.length) continue;

    // Idempotency guard — fetch any ISSUE_STALLED events within the
    // grace window for this batch in one round-trip rather than N.
    const recentStalls = await client.activityEvent.findMany({
      where: {
        workspaceId: ws.id,
        kind: EventKind.ISSUE_STALLED,
        subjectType: "issue",
        subjectId: { in: candidates.map((c) => c.id) },
        createdAt: { gte: restallSince },
      },
      select: { subjectId: true },
    });
    const recentlyStalled = new Set(recentStalls.map((e) => e.subjectId));

    // Mode gate — one query for the whole batch. `distinct` + `orderBy`
    // gives the most recent run per issue; an issue with no run yet
    // (dispatch may have silently failed to start at all — the original
    // failure mode this watchdog exists for) has no entry here and is
    // NOT skipped, since that's exactly the case worth flagging.
    const latestRuns = await client.agentRun.findMany({
      where: { issueId: { in: candidates.map((c) => c.id) } },
      orderBy: { startedAt: "desc" },
      distinct: ["issueId"],
      select: { issueId: true, engagementMode: true },
    });
    const latestModeByIssueId = new Map(latestRuns.map((r) => [r.issueId, r.engagementMode]));

    for (const issue of candidates) {
      if (recentlyStalled.has(issue.id)) continue;
      // Defensive: the where clause already filters this, but the
      // assignedAgentId nullable in Prisma's typed shape requires a guard.
      if (!issue.assignedAgentId) continue;
      const latestMode = latestModeByIssueId.get(issue.id);
      if (latestMode && latestMode !== EngagementMode.EXECUTE) continue;

      const payload = {
        assignedAgentId: issue.assignedAgentId,
        agentProfileKey: issue.assignedAgent?.profileKey ?? null,
        slaMinutes: ws.assignmentSlaMinutes,
        lastUpdate: issue.updatedAt.toISOString(),
      };

      try {
        await recordChange(client, {
          workspaceId: ws.id,
          actorId: null,
          entity: "Issue",
          entityId: issue.id,
          action: "stalled",
          before: { assignedAgentId: issue.assignedAgentId },
          after: ws.autoRedispatchOnStall
            ? { assignedAgentId: null }
            : { assignedAgentId: issue.assignedAgentId },
          eventKind: EventKind.ISSUE_STALLED,
          subjectType: "issue",
          subjectId: issue.id,
          payload,
        });
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, workspaceId: ws.id },
          "stale-work sweep: audit failed",
        );
        continue;
      }

      stalled.push(issue.id);

      // Fire-and-forget Coach comment. No-op when AI is off or there's
      // no COACH agent in the workspace; never blocks the sweep.
      void coachOnEvent(client, {
        workspaceId: ws.id,
        issueId: issue.id,
        eventKind: "ISSUE_STALLED",
      });

      if (ws.autoRedispatchOnStall) {
        try {
          await client.issue.update({
            where: { id: issue.id },
            data: { assignedAgentId: null },
          });
          redispatched.push(issue.id);
          // Best-effort re-pick. The dispatcher short-circuits when the
          // workspace's autoDispatch is off or the issue isn't queued —
          // either way we already cleared assignment, so an operator can
          // hand-route from there.
          await maybeAutoDispatch(client, issue.id);
        } catch (err) {
          logger.warn(
            { err, issueId: issue.id, workspaceId: ws.id },
            "stale-work sweep: redispatch failed",
          );
        }
      }
    }
  }

  if (stalled.length) {
    logger.info(
      {
        stalled: stalled.length,
        redispatched: redispatched.length,
        workspaces: workspaces.length,
      },
      "stale-work sweep: issues flagged",
    );
  }

  return {
    workspacesScanned: workspaces.length,
    stalled,
    redispatched,
  };
}
