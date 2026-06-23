import "server-only";
import type { PrismaClient } from "@prisma/client";
import {
  ActionRequestKind,
  AgentRunStatus,
  EventKind,
  NotificationSeverity,
  Prisma,
  RunBudgetAction,
} from "@prisma/client";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { recordChange } from "@/server/audit";
import { appendRunEvent } from "@/server/services/agent-run";
import { createActionRequest } from "@/server/services/action-request-service";
import type { DispatchConnector } from "@/server/services/dispatch/types";

/**
 * Per-run safety budgets (Phase 1, 2026-06-23). The stale watchdog only
 * catches *idle* runs; this catches a busy-but-runaway loop — the AXI-75
 * run that burned 21.1M input tokens because nothing capped it.
 *
 * Budgets are opt-in workspace knobs (null/0 = unlimited). When a run
 * crosses `runBudgetWarnPct` of any set budget we emit a one-time
 * advisory warning; when it breaches a cap we STOP the provider run
 * (best-effort) and then either PAUSE it (default — park WAITING with a
 * clear reason + an actionable "raise budget & resume / abandon"
 * notification) or STOP it (close ABANDONED). Either way the run lands in
 * a defined state and the operator is told — never a silent dangling run.
 */

export const RUN_BUDGET_WORKSPACE_SELECT = {
  runTokenBudget: true,
  runCostBudgetUsd: true,
  runMaxMinutes: true,
  runBudgetWarnPct: true,
  runBudgetAction: true,
} as const;

export interface RunBudgetLimits {
  runTokenBudget: number | null;
  runCostBudgetUsd: Prisma.Decimal | null;
  runMaxMinutes: number | null;
  runBudgetWarnPct: number;
  runBudgetAction: RunBudgetAction;
}

export type BudgetMetric = "tokens" | "cost" | "time";

export interface RunBudgetUsage {
  tokens: number | null;
  costUsd: number | null;
  elapsedMinutes: number | null;
}

export interface RunBudgetVerdict {
  state: "ok" | "warn" | "breach";
  /** The worst (closest-to/over-limit) metric, or null when no budget is set. */
  metric: BudgetMetric | null;
  used: number | null;
  limit: number | null;
  /** Worst ratio used/limit across set budgets (>=1 means breach). */
  ratio: number | null;
}

export function hasAnyBudget(limits: RunBudgetLimits): boolean {
  return (
    (limits.runTokenBudget ?? 0) > 0 ||
    (limits.runCostBudgetUsd != null && Number(limits.runCostBudgetUsd) > 0) ||
    (limits.runMaxMinutes ?? 0) > 0
  );
}

/** Derive the comparable usage triple from a run row + a reference time. */
export function budgetUsageFromRun(
  run: {
    startedAt: Date;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: Prisma.Decimal | number | null;
  },
  now: Date = new Date(),
): RunBudgetUsage {
  const tin = run.tokensIn ?? null;
  const tout = run.tokensOut ?? null;
  const tokens = tin != null || tout != null ? (tin ?? 0) + (tout ?? 0) : null;
  const costUsd = run.costUsd != null ? Number(run.costUsd) : null;
  const elapsedMinutes = Math.max(0, (now.getTime() - run.startedAt.getTime()) / 60_000);
  return { tokens, costUsd, elapsedMinutes };
}

/** Pure budget classifier — no side effects, unit-testable. */
export function evaluateRunBudget(
  limits: RunBudgetLimits,
  usage: RunBudgetUsage,
): RunBudgetVerdict {
  const checks: Array<{ metric: BudgetMetric; used: number; limit: number }> = [];
  if ((limits.runTokenBudget ?? 0) > 0 && usage.tokens != null) {
    checks.push({ metric: "tokens", used: usage.tokens, limit: limits.runTokenBudget! });
  }
  const costLimit = limits.runCostBudgetUsd != null ? Number(limits.runCostBudgetUsd) : 0;
  if (costLimit > 0 && usage.costUsd != null) {
    checks.push({ metric: "cost", used: usage.costUsd, limit: costLimit });
  }
  if ((limits.runMaxMinutes ?? 0) > 0 && usage.elapsedMinutes != null) {
    checks.push({ metric: "time", used: usage.elapsedMinutes, limit: limits.runMaxMinutes! });
  }
  if (checks.length === 0) {
    return { state: "ok", metric: null, used: null, limit: null, ratio: null };
  }
  let worst = checks[0];
  let worstRatio = checks[0].used / checks[0].limit;
  for (const c of checks) {
    const ratio = c.used / c.limit;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worst = c;
    }
  }
  const warnFrac = (limits.runBudgetWarnPct > 0 ? limits.runBudgetWarnPct : 100) / 100;
  const state: RunBudgetVerdict["state"] =
    worstRatio >= 1 ? "breach" : worstRatio >= warnFrac ? "warn" : "ok";
  return { state, metric: worst.metric, used: worst.used, limit: worst.limit, ratio: worstRatio };
}

function fmtMetric(metric: BudgetMetric | null, value: number | null): string {
  if (metric == null || value == null) return "?";
  if (metric === "tokens") return `${Math.round(value).toLocaleString("en-US")} tok`;
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return `${Math.round(value)}m`;
}

type BudgetMeta = { warnedAt?: string; breachedAt?: string } & Record<string, unknown>;

function readBudgetMeta(completionMeta: unknown): {
  meta: Record<string, unknown>;
  budget: BudgetMeta;
} {
  const meta =
    completionMeta && typeof completionMeta === "object"
      ? ({ ...(completionMeta as Record<string, unknown>) })
      : {};
  const budget =
    meta.budget && typeof meta.budget === "object"
      ? ({ ...(meta.budget as BudgetMeta) })
      : ({} as BudgetMeta);
  return { meta, budget };
}

export interface EnforceRunBudgetInput {
  run: {
    id: string;
    workspaceId: string;
    issueId: string;
    agentId: string;
    status: AgentRunStatus;
    externalRunId?: string | null;
    completionMeta?: unknown;
    startedAt: Date;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: Prisma.Decimal | number | null;
  };
  limits: RunBudgetLimits;
  /** Live usage override (e.g. from a connector poll); falls back to the run row. */
  usage?: RunBudgetUsage;
  /** When supplied + breach, the provider run is stopped first to halt spend. */
  connector?: DispatchConnector | null;
  client?: PrismaClient;
}

/**
 * Evaluate + act on a run's budget. Idempotent: a one-time warning per run,
 * and a breach is handled once (guarded by markers in completionMeta.budget).
 * Only ACTIVE runs are acted on — a WAITING/terminal run is already parked.
 * Returns the verdict (so callers can short-circuit their own processing on
 * breach).
 */
export async function enforceRunBudget(
  input: EnforceRunBudgetInput,
): Promise<RunBudgetVerdict> {
  const client = input.client ?? db;
  const { run } = input;
  if (run.status !== AgentRunStatus.ACTIVE) {
    return { state: "ok", metric: null, used: null, limit: null, ratio: null };
  }
  if (!hasAnyBudget(input.limits)) {
    return { state: "ok", metric: null, used: null, limit: null, ratio: null };
  }

  const usage = input.usage ?? budgetUsageFromRun(run);
  const verdict = evaluateRunBudget(input.limits, usage);
  if (verdict.state === "ok") return verdict;

  const { meta, budget } = readBudgetMeta(run.completionMeta);

  if (verdict.state === "warn") {
    if (budget.warnedAt) return verdict; // one-time
    const nextBudget = {
      ...budget,
      warnedAt: new Date().toISOString(),
      warnedMetric: verdict.metric,
      warnedRatio: verdict.ratio,
    };
    await client
      .$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: run.id },
          data: { completionMeta: { ...meta, budget: nextBudget } as Prisma.InputJsonValue },
        });
        await recordChange(tx, {
          workspaceId: run.workspaceId,
          actorId: null,
          entity: "AgentRun",
          entityId: run.id,
          action: "budget-warning",
          after: { metric: verdict.metric, ratio: verdict.ratio },
          eventKind: EventKind.AGENT_RUN_BUDGET_WARNING,
          subjectType: "agent-run",
          subjectId: run.id,
          payload: {
            runId: run.id,
            issueId: run.issueId,
            agentId: run.agentId,
            metric: verdict.metric,
            used: verdict.used,
            limit: verdict.limit,
            pct: Math.round((verdict.ratio ?? 0) * 100),
          },
        });
      })
      .catch((err) =>
        logger.warn({ err, runId: run.id }, "run-budget: warn update failed"),
      );
    return verdict;
  }

  // breach — handle once. The in-memory guard catches the sequential case;
  // the atomic status-flip claim below serializes a true race between the
  // worker poll and a web recordUsage call (different processes).
  if (budget.breachedAt) return verdict;

  // 1. Halt provider spend immediately (best-effort, outside the tx). Track
  // whether we actually stopped it so we don't lie to the operator: a webhook
  // run or an unconfigured connector has no stop hook.
  let stopped = false;
  if (input.connector?.stop && run.externalRunId) {
    try {
      await input.connector.stop(run.externalRunId);
      stopped = true;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "run-budget: connector.stop failed");
    }
  }

  const action = input.limits.runBudgetAction;
  const reason = `over ${verdict.metric} budget (${fmtMetric(verdict.metric, verdict.used)} / ${fmtMetric(verdict.metric, verdict.limit)})`;
  const nextMeta = {
    ...meta,
    budget: {
      ...budget,
      breachedAt: new Date().toISOString(),
      breachedMetric: verdict.metric,
      used: verdict.used,
      limit: verdict.limit,
      action,
      stopped,
    },
  } as Prisma.InputJsonValue;

  let claimedWinner = false;
  await client
    .$transaction(async (tx) => {
      if (action === RunBudgetAction.STOP) {
        // Atomic claim: only the writer that flips ACTIVE→ABANDONED proceeds.
        const claim = await tx.agentRun.updateMany({
          where: { id: run.id, status: AgentRunStatus.ACTIVE },
          data: {
            status: AgentRunStatus.ABANDONED,
            finishedAt: new Date(),
            completionMeta: nextMeta,
            // If we couldn't confirm the provider stopped, leave a cancel
            // signal a polling runtime can still honor; else clear it.
            controlState: stopped ? "NONE" : "CANCEL_REQUESTED",
            controlRequestedAt: stopped ? null : new Date(),
            summary: `Stopped by the run-budget watchdog: ${reason}.`,
            awaitingApprovalAt: null,
            pendingApproval: Prisma.DbNull,
          },
        });
        if (claim.count === 0) return; // lost the race — another writer handled it
        claimedWinner = true;
        await tx.agentRunEvent.create({
          data: {
            workspaceId: run.workspaceId,
            runId: run.id,
            kind: "ABANDONED",
            payload: { reason: `over-budget: ${reason}`, stopped },
          },
        });
        await recordChange(tx, {
          workspaceId: run.workspaceId,
          actorId: null,
          entity: "AgentRun",
          entityId: run.id,
          action: "finish",
          after: { status: "ABANDONED" },
          eventKind: EventKind.AGENT_RUN_COMPLETED,
          subjectType: "agent-run",
          subjectId: run.id,
          payload: {
            runId: run.id,
            issueId: run.issueId,
            agentId: run.agentId,
            finalStatus: "ABANDONED",
            reason: "over-budget",
          },
        });
      } else {
        // PAUSE (default): atomic claim ACTIVE→WAITING. WAITING parks the run
        // so the idle watchdog leaves it alone; the breach marker re-arms on a
        // legitimate resume (see clearBudgetMarkers) so it can never silently
        // resume uncapped.
        const claim = await tx.agentRun.updateMany({
          where: { id: run.id, status: AgentRunStatus.ACTIVE },
          data: {
            status: AgentRunStatus.WAITING,
            completionMeta: nextMeta,
            controlState: "PAUSE_REQUESTED",
            controlRequestedAt: new Date(),
            currentStep: `paused: ${reason}`,
            awaitingApprovalAt: null,
            pendingApproval: Prisma.DbNull,
          },
        });
        if (claim.count === 0) return; // lost the race
        claimedWinner = true;
        await appendRunEvent(tx, {
          runId: run.id,
          workspaceId: run.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          kind: "BUDGET_PAUSED",
          currentStep: `paused: ${reason}`,
          payload: { metric: verdict.metric, used: verdict.used, limit: verdict.limit, stopped },
        });
      }
      await recordChange(tx, {
        workspaceId: run.workspaceId,
        actorId: null,
        entity: "AgentRun",
        entityId: run.id,
        action: "budget-breach",
        after: { metric: verdict.metric, action },
        eventKind: EventKind.AGENT_RUN_BUDGET_BREACHED,
        subjectType: "agent-run",
        subjectId: run.id,
        payload: {
          runId: run.id,
          issueId: run.issueId,
          agentId: run.agentId,
          metric: verdict.metric,
          used: verdict.used,
          limit: verdict.limit,
          action,
          stopped,
        },
      });
    })
    .catch((err) =>
      logger.warn({ err, runId: run.id }, "run-budget: breach handling failed"),
    );

  // Only the winning writer notifies, and only for PAUSE. The notification is
  // honest about whether spend was actually halted. FREE_FORM requests don't
  // dedup (only scoped grants do), so this never collapses an unrelated
  // operator ask — and the once-per-breach guard keeps it to one card per run.
  if (claimedWinner && action === RunBudgetAction.PAUSE) {
    const spendLine = stopped
      ? "The provider run was stopped, so no further spend continues while paused."
      : "Forge could not confirm the provider stopped — it may still be running, so abandon the run if needed.";
    await createActionRequest(db, {
      workspaceId: run.workspaceId,
      title: `Run paused — ${reason}`,
      body:
        "This agent run hit the workspace per-run budget and was paused to avoid a runaway. " +
        spendLine +
        " Raise the budget in Settings → Workspace and resume the run, or abandon it.",
      severity: NotificationSeverity.WARNING,
      kind: ActionRequestKind.FREE_FORM,
      actorId: null,
      actorAgentId: run.agentId,
      issueId: run.issueId,
      sourceType: "agent-run",
      sourceId: run.id,
    }).catch((err) =>
      logger.warn({ err, runId: run.id }, "run-budget: pause notification failed"),
    );
  }

  return verdict;
}

/**
 * Strip the breach/warn markers from a run's completionMeta so budget
 * enforcement RE-ARMS. Called on every WAITING→ACTIVE resume: without this,
 * a paused runaway resumes with breachedAt still set and enforceRunBudget
 * short-circuits forever — the run would loop uncapped (the AXI-75 pathology).
 * Returns the updated meta, or undefined when there's nothing to clear (so
 * normal resumes are a no-op).
 */
export function clearBudgetMarkers(completionMeta: unknown): Prisma.InputJsonValue | undefined {
  if (!completionMeta || typeof completionMeta !== "object") return undefined;
  const meta = { ...(completionMeta as Record<string, unknown>) };
  if (!meta.budget || typeof meta.budget !== "object") return undefined;
  const budget = { ...(meta.budget as Record<string, unknown>) };
  if (budget.breachedAt === undefined && budget.warnedAt === undefined) return undefined;
  delete budget.breachedAt;
  delete budget.breachedMetric;
  delete budget.warnedAt;
  delete budget.warnedMetric;
  delete budget.stopped;
  budget.rearmedAt = new Date().toISOString();
  meta.budget = budget;
  return meta as Prisma.InputJsonValue;
}
