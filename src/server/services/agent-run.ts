import "server-only";
import type { PrismaClient, AgentRun, EngagementMode } from "@prisma/client";
import { AgentRunStatus, EventKind, Prisma } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { publish } from "@/server/realtime";
import { nanoid } from "nanoid";

/**
 * AgentRun lifecycle service.
 *
 * One AgentRun = "agent X is actively working issue Y" — opens on the
 * first activity from the agent against the issue, stays ACTIVE while
 * events keep landing, and closes when the issue transitions to a
 * terminal status, the agent reports completion, or the watchdog flags
 * it stalled.
 *
 * The lifecycle is intentionally granular but cheap: each event is one
 * `AgentRunEvent` row + a `lastEventAt` bump + a fire-and-forget Redis
 * publish on the existing workspace SSE channel. Heavier transitions
 * (start / finish / stall) also go through `recordChange()` so they
 * land in the audit log + activity stream.
 *
 * Callers always pass an open Prisma client (tx or base) so this can
 * compose into the same transaction as the triggering write.
 */

type Tx = PrismaClient | Prisma.TransactionClient;

/**
 * Lightweight SSE-only publish. Used for high-frequency STEP / TOOL
 * events where we don't want to spam the AuditLog + ActivityEvent
 * tables. Mirrors the RealtimeEvent shape the browser already knows
 * how to consume (subjectType + subjectId + payload + kind).
 */
function publishRunEvent(params: {
  workspaceId: string;
  kind: EventKind;
  runId: string;
  issueId: string;
  agentId: string;
  payload?: Record<string, unknown>;
}): void {
  void publish({
    id: nanoid(),
    workspaceId: params.workspaceId,
    kind: params.kind,
    subjectType: "agent-run",
    subjectId: params.runId,
    payload: {
      ...params.payload,
      runId: params.runId,
      issueId: params.issueId,
      agentId: params.agentId,
    },
    actorId: null,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Returns the active (non-terminal) run for this (issue, agent) tuple,
 * or null. There can be at most one non-terminal run per (issue, agent)
 * by convention — every call site goes through `openOrTouchRun()` which
 * enforces it.
 *
 * "Non-terminal" includes both ACTIVE and WAITING. A WAITING run is a
 * patient agent that's blocked on the operator; subsequent activity
 * (operator nudge, MCP write) should resume it rather than open a
 * fresh second run — `openOrTouchRun` handles the resume.
 */
export async function findActiveRun(
  tx: Tx,
  params: { issueId: string; agentId: string },
): Promise<AgentRun | null> {
  return tx.agentRun.findFirst({
    where: {
      issueId: params.issueId,
      agentId: params.agentId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
    },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Open a new ACTIVE run for (issue, agent), or touch the existing one.
 * Opening emits AGENT_RUN_STARTED via `recordChange()` so the audit log
 * + SSE stream get a durable marker. Touching just bumps lastEventAt.
 *
 * Returns `{ run, isNew }`. Callers can branch on `isNew` to gate
 * notifications they only want on the first activity (e.g. "Victor
 * started work on AXI-31").
 */
export async function openOrTouchRun(
  tx: Tx,
  params: {
    workspaceId: string;
    issueId: string;
    agentId: string;
    actorId?: string | null;
    actorAgentId?: string | null;
    assignmentEventId?: string | null;
    currentStep?: string | null;
    /** Set when the run executes a Goal-orchestration ExecutionStep (AXI-57). */
    executionStepId?: string | null;
    /** Engagement mode for this run (AXI-53). Defaults EXECUTE when unset. */
    engagementMode?: EngagementMode | null;
  },
): Promise<{ run: AgentRun; isNew: boolean }> {
  const existing = await findActiveRun(tx, {
    issueId: params.issueId,
    agentId: params.agentId,
  });

  if (existing) {
    // Auto-resume WAITING runs: a fresh action on a WAITING run is
    // strong evidence the agent is back on the loop. Flip to ACTIVE
    // and bump `lastEventAt` so the stale watchdog restarts fresh.
    // Conscious choice not to emit a separate event here — the
    // triggering caller (comment.create, MCP write, etc.) already
    // records its own audit row.
    const resumeFromWaiting = existing.status === AgentRunStatus.WAITING;
    const updated = await tx.agentRun.update({
      where: { id: existing.id },
      data: {
        lastEventAt: new Date(),
        ...(resumeFromWaiting ? { status: AgentRunStatus.ACTIVE } : {}),
        ...(params.assignmentEventId && !existing.assignmentEventId
          ? { assignmentEventId: params.assignmentEventId }
          : {}),
        ...(params.currentStep !== undefined ? { currentStep: params.currentStep } : {}),
        ...(params.engagementMode ? { engagementMode: params.engagementMode } : {}),
      },
    });
    return { run: updated, isNew: false };
  }

  const run = await tx.agentRun.create({
    data: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      status: AgentRunStatus.ACTIVE,
      assignmentEventId: params.assignmentEventId ?? null,
      currentStep: params.currentStep ?? null,
      executionStepId: params.executionStepId ?? null,
      ...(params.engagementMode ? { engagementMode: params.engagementMode } : {}),
    },
  });

  // Stamp the opening AgentRunEvent so the timeline starts with a
  // STARTED row even before any subsequent step / status update.
  await tx.agentRunEvent.create({
    data: {
      workspaceId: params.workspaceId,
      runId: run.id,
      kind: "STARTED",
      payload: { assignmentEventId: params.assignmentEventId ?? null },
    },
  });

  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId ?? null,
    actorAgentId: params.actorAgentId ?? null,
    entity: "AgentRun",
    entityId: run.id,
    action: "create",
    after: run,
    eventKind: EventKind.AGENT_RUN_STARTED,
    subjectType: "agent-run",
    subjectId: run.id,
    payload: {
      runId: run.id,
      issueId: params.issueId,
      agentId: params.agentId,
      assignmentEventId: params.assignmentEventId ?? null,
    },
  });

  return { run, isNew: true };
}

/**
 * Append a timeline event to an existing run. Bumps `lastEventAt` so
 * the watchdog sees freshness. `currentStep` (when supplied) replaces
 * the run's denormalized current-step label so the live pulse strip
 * has something to render without scanning the events table.
 *
 * `kind` is freeform — STEP / TOOL_CALL / STATUS / ACK / BLOCKED /
 * COMPLETED / ERRORED are conventional but agents can stamp arbitrary
 * loop step names. The Redis publish carries the kind through to the
 * client so the live strip can render an icon variant per kind.
 */
export async function appendRunEvent(
  tx: Tx,
  params: {
    runId: string;
    workspaceId: string;
    issueId: string;
    agentId: string;
    kind: string;
    payload?: Prisma.InputJsonValue;
    currentStep?: string | null;
  },
): Promise<void> {
  await tx.agentRunEvent.create({
    data: {
      workspaceId: params.workspaceId,
      runId: params.runId,
      kind: params.kind,
      payload: params.payload ?? Prisma.JsonNull,
    },
  });
  await tx.agentRun.update({
    where: { id: params.runId },
    data: {
      lastEventAt: new Date(),
      ...(params.currentStep !== undefined ? { currentStep: params.currentStep } : {}),
    },
  });

  // Lightweight SSE-only publish — no AuditLog row, no ActivityEvent
  // row. The events table is the durable timeline; this is just for the
  // live strip to react in real time.
  publishRunEvent({
    workspaceId: params.workspaceId,
    kind: EventKind.AGENT_RUN_STEP,
    runId: params.runId,
    issueId: params.issueId,
    agentId: params.agentId,
    payload: {
      eventKind: params.kind,
      currentStep: params.currentStep ?? null,
    },
  });
}

/**
 * Close an ACTIVE run with a terminal status. Emits the appropriate
 * AGENT_RUN_* event via `recordChange()` so the audit log records
 * who/why/when. Callers use this when the issue transitions to a
 * terminal status (COMPLETED), is manually canceled (ABANDONED), or
 * the watchdog flags it (STALLED).
 *
 * Idempotent: returns null if the run is already terminal.
 */
export async function finishRun(
  tx: Tx,
  params: {
    runId: string;
    workspaceId: string;
    issueId: string;
    agentId: string;
    status: "COMPLETED" | "ABANDONED" | "STALLED";
    summary?: string | null;
    actorId?: string | null;
    actorAgentId?: string | null;
  },
): Promise<AgentRun | null> {
  const existing = await tx.agentRun.findUnique({ where: { id: params.runId } });
  if (!existing) return null;
  if (existing.status !== AgentRunStatus.ACTIVE) return existing;

  const finished = await tx.agentRun.update({
    where: { id: params.runId },
    data: {
      status: AgentRunStatus[params.status],
      finishedAt: new Date(),
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
    },
  });

  await tx.agentRunEvent.create({
    data: {
      workspaceId: params.workspaceId,
      runId: params.runId,
      kind: params.status,
      payload: { summary: params.summary ?? null },
    },
  });

  const eventKind =
    params.status === "STALLED" ? EventKind.AGENT_RUN_STALLED : EventKind.AGENT_RUN_COMPLETED;

  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: params.actorId ?? null,
    actorAgentId: params.actorAgentId ?? null,
    entity: "AgentRun",
    entityId: params.runId,
    action: "finish",
    after: finished,
    eventKind,
    subjectType: "agent-run",
    subjectId: params.runId,
    payload: {
      runId: params.runId,
      issueId: params.issueId,
      agentId: params.agentId,
      finalStatus: params.status,
      summary: params.summary ?? null,
    },
  });

  return finished;
}

/**
 * Convenience: open-or-touch + append in one call. Used at every place
 * where an agent action lands (webhook delivery, MCP write, status
 * upsert) so the lifecycle is "first action opens the run, every
 * subsequent action keeps it warm."
 *
 * Returns the run id + whether the run was just opened. Callers can
 * branch on `isNewRun` to e.g. emit a one-time "Victor started work"
 * notification without spamming on every step.
 */
export async function recordAgentAction(
  tx: Tx,
  params: {
    workspaceId: string;
    issueId: string;
    agentId: string;
    kind: string;
    payload?: Prisma.InputJsonValue;
    currentStep?: string | null;
    actorId?: string | null;
    actorAgentId?: string | null;
    assignmentEventId?: string | null;
  },
): Promise<{ runId: string; isNewRun: boolean }> {
  const { run, isNew } = await openOrTouchRun(tx, {
    workspaceId: params.workspaceId,
    issueId: params.issueId,
    agentId: params.agentId,
    actorId: params.actorId ?? null,
    actorAgentId: params.actorAgentId ?? null,
    assignmentEventId: params.assignmentEventId ?? null,
    currentStep: params.currentStep,
  });

  // Skip the "STARTED" duplicate event when the run was just opened —
  // openOrTouchRun already wrote that row + recorded it.
  if (!isNew) {
    await appendRunEvent(tx, {
      runId: run.id,
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      kind: params.kind,
      payload: params.payload,
      currentStep: params.currentStep,
    });
  }

  return { runId: run.id, isNewRun: isNew };
}

/**
 * Close every ACTIVE run for an issue. Called from the issue.transition
 * path when the issue lands in a terminal status (DONE / CANCELED) so
 * stale runs don't linger in the live-pulse UI.
 *
 * Returns the count closed. Best-effort — if no runs are ACTIVE the
 * call is a no-op.
 */
export async function finishRunsForIssue(
  tx: Tx,
  params: {
    workspaceId: string;
    issueId: string;
    status: "COMPLETED" | "ABANDONED";
    actorId?: string | null;
    actorAgentId?: string | null;
  },
): Promise<number> {
  const active = await tx.agentRun.findMany({
    where: { issueId: params.issueId, status: AgentRunStatus.ACTIVE },
    select: {
      id: true,
      agentId: true,
      externalRunId: true,
      acknowledgedAt: true,
      outputStartedAt: true,
    },
  });
  for (const r of active) {
    const runDidWork =
      r.agentId === params.actorAgentId ||
      !!r.externalRunId ||
      !!r.acknowledgedAt ||
      !!r.outputStartedAt;
    const demotedUnstartedCompletion = params.status === "COMPLETED" && !runDidWork;
    const status = demotedUnstartedCompletion ? "ABANDONED" : params.status;
    const summary = demotedUnstartedCompletion
      ? "Closed without completion because the issue reached Done before this run acknowledged or started."
      : undefined;
    await finishRun(tx, {
      runId: r.id,
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: r.agentId,
      status,
      summary,
      actorId: demotedUnstartedCompletion && params.actorAgentId ? null : (params.actorId ?? null),
      actorAgentId: demotedUnstartedCompletion ? null : (params.actorAgentId ?? null),
    });
  }
  return active.length;
}
