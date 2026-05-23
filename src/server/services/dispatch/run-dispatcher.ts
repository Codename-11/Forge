import "server-only";
import { AgentRunStatus, EventKind } from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { openOrTouchRun, appendRunEvent, finishRun } from "@/server/services/agent-run";
import { getRunsConnector, resolveRunEngine } from "./registry";

/**
 * Dispatch-via-runs ingestion (worker-hosted, poll-based).
 *
 * Phase 2 of the pluggable-engine work. When an issue is assigned to a
 * RUNS-engine agent, Forge drives the work through the provider's
 * structured agent-run API (Hermes `/v1/runs`) rather than a webhook:
 *
 *   1. `startNewRuns` — find recent AGENT_ASSIGNED events whose assignee is
 *      a RUNS-engine agent and that don't yet have an AgentRun; open the
 *      AgentRun and `startRun` on the connector, stashing `externalRunId`.
 *   2. `pollActiveRuns` — for ACTIVE AgentRuns with an `externalRunId`, poll
 *      `getStatus` and mirror it onto the AgentRun (currentStep / token
 *      usage / terminal finish) so Mission Control reflects live progress.
 *
 * Polling (vs a live SSE subscription) fits the worker's short-job model
 * and is trivially restart-safe — there's no in-memory subscription state
 * to lose. The webhook path remains for COMPLETIONS / legacy agents; a
 * RUNS agent simply shouldn't also carry a dispatch `webhookUrl` (that
 * would double-dispatch).
 */

const ASSIGNMENT_LOOKBACK_MS = 15 * 60_000;
const START_BATCH = 10;
const POLL_BATCH = 25;

function issueMessage(issue: {
  key: string;
  title: string;
  description: string | null;
}): string {
  const body = issue.description?.trim();
  return (
    `You are assigned Forge issue ${issue.key}: ${issue.title}.\n\n` +
    (body ? `${body}\n\n` : "") +
    `Work the issue using your tools, then summarise what you did.`
  );
}

/** Issue keys are derived (`<workspace.key>-<number>`), not a column. */
function issueKey(workspaceKey: string, number: number): string {
  return `${workspaceKey}-${number}`;
}

/** Open AgentRuns + start provider runs for fresh RUNS-engine assignments. */
async function startNewRuns(): Promise<number> {
  const events = await db.activityEvent.findMany({
    where: {
      kind: EventKind.AGENT_ASSIGNED,
      subjectType: "issue",
      createdAt: { gte: new Date(Date.now() - ASSIGNMENT_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: START_BATCH * 3,
    select: { id: true, workspaceId: true, subjectId: true },
  });

  let started = 0;
  for (const evt of events) {
    if (started >= START_BATCH) break;
    if (!evt.subjectId) continue;
    // Dedup: one provider run per assignment event.
    const already = await db.agentRun.findFirst({
      where: { assignmentEventId: evt.id },
      select: { id: true },
    });
    if (already) continue;

    const issue = await db.issue.findUnique({
      where: { id: evt.subjectId },
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        assignedAgentId: true,
        workspace: { select: { key: true } },
        assignedAgent: {
          select: { id: true, provider: true, runEngine: true },
        },
      },
    });
    const agent = issue?.assignedAgent;
    if (!issue || !agent) continue;
    if (resolveRunEngine({ runEngine: agent.runEngine, provider: agent.provider }) !== "RUNS") {
      continue;
    }
    const connector = getRunsConnector(agent.provider);
    if (!connector) continue;

    try {
      const { externalRunId } = await connector.startRun({
        message: issueMessage({
          key: issueKey(issue.workspace.key, issue.number),
          title: issue.title,
          description: issue.description,
        }),
      });
      await db.$transaction(async (tx) => {
        const { run } = await openOrTouchRun(tx, {
          workspaceId: evt.workspaceId,
          issueId: issue.id,
          agentId: agent.id,
          assignmentEventId: evt.id,
          currentStep: "starting run",
        });
        await tx.agentRun.update({
          where: { id: run.id },
          data: { externalRunId, acknowledgedAt: new Date() },
        });
        await appendRunEvent(tx, {
          runId: run.id,
          workspaceId: evt.workspaceId,
          issueId: issue.id,
          agentId: agent.id,
          kind: "DISPATCH_STARTED",
          currentStep: "running",
          payload: { externalRunId, engine: "RUNS" },
        });
      });
      started++;
    } catch (err) {
      logger.warn({ err, eventId: evt.id, issueId: issue.id }, "runs-dispatch: start failed");
    }
  }
  return started;
}

/** Poll live provider runs and mirror status onto the AgentRun. */
async function pollActiveRuns(): Promise<number> {
  const runs = await db.agentRun.findMany({
    where: { status: AgentRunStatus.ACTIVE, externalRunId: { not: null } },
    orderBy: { lastEventAt: "asc" },
    take: POLL_BATCH,
    select: {
      id: true,
      workspaceId: true,
      issueId: true,
      agentId: true,
      externalRunId: true,
      currentStep: true,
      awaitingApprovalAt: true,
      agent: { select: { provider: true } },
    },
  });

  let polled = 0;
  for (const run of runs) {
    const connector = getRunsConnector(run.agent.provider);
    if (!connector?.getStatus || !run.externalRunId) continue;
    let status;
    try {
      status = await connector.getStatus(run.externalRunId);
    } catch (err) {
      logger.warn({ err, runId: run.id }, "runs-dispatch: poll failed");
      continue;
    }
    polled++;

    if (status.state === "waiting_for_approval") {
      // Transition into a blocked state (set the flag + a BLOCKED event)
      // only once, so we don't spam the timeline while it waits.
      if (!run.awaitingApprovalAt) {
        await db
          .$transaction(async (tx) => {
            await tx.agentRun.update({
              where: { id: run.id },
              data: { awaitingApprovalAt: new Date() },
            });
            await appendRunEvent(tx, {
              runId: run.id,
              workspaceId: run.workspaceId,
              issueId: run.issueId,
              agentId: run.agentId,
              kind: "BLOCKED",
              currentStep: "waiting for approval",
              payload: { lastEvent: status.lastEvent ?? null },
            });
          })
          .catch((err) =>
            logger.warn({ err, runId: run.id }, "runs-dispatch: block update failed"),
          );
      }
      continue;
    }

    if (status.state === "running") {
      const step = status.lastEvent ?? "running";
      // Clear a prior approval block (operator approved → agent resumed)
      // or just advance the step label.
      if (run.awaitingApprovalAt || step !== run.currentStep) {
        await db
          .$transaction(async (tx) => {
            if (run.awaitingApprovalAt) {
              await tx.agentRun.update({
                where: { id: run.id },
                data: { awaitingApprovalAt: null },
              });
            }
            await appendRunEvent(tx, {
              runId: run.id,
              workspaceId: run.workspaceId,
              issueId: run.issueId,
              agentId: run.agentId,
              kind: "STEP",
              currentStep: step,
              payload: { lastEvent: status.lastEvent ?? null },
            });
          })
          .catch((err) =>
            logger.warn({ err, runId: run.id }, "runs-dispatch: step update failed"),
          );
      }
      continue;
    }

    // Terminal — finish the run and mirror usage.
    const terminal: "COMPLETED" | "ABANDONED" | "STALLED" =
      status.state === "completed"
        ? "COMPLETED"
        : status.state === "cancelled"
          ? "ABANDONED"
          : "STALLED";
    await db
      .$transaction(async (tx) => {
        await finishRun(tx, {
          runId: run.id,
          workspaceId: run.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: terminal,
          summary: status.output ?? null,
        });
        const usage = status.usage;
        await tx.agentRun.update({
          where: { id: run.id },
          data: {
            awaitingApprovalAt: null,
            ...(usage && (usage.tokensIn || usage.tokensOut || usage.costUsd)
              ? {
                  tokensIn: usage.tokensIn ?? null,
                  tokensOut: usage.tokensOut ?? null,
                  costUsd: usage.costUsd ?? null,
                }
              : {}),
          },
        });
      })
      .catch((err) => logger.warn({ err, runId: run.id }, "runs-dispatch: finish failed"));
  }
  return polled;
}

/** One worker tick: start fresh runs, then poll live ones. */
export async function ingestRunsDispatch(): Promise<{ started: number; polled: number }> {
  const started = await startNewRuns();
  const polled = await pollActiveRuns();
  if (started > 0 || polled > 0) {
    logger.info({ started, polled }, "runs-dispatch: tick");
  }
  return { started, polled };
}
