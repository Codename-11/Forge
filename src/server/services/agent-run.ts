import "server-only";
import type {
  PrismaClient,
  AgentRun,
  EngagementMode,
  RunEngine,
  LivenessConfidence,
} from "@prisma/client";
import { ActionRequestStatus, AgentRunStatus, EventKind, Prisma } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { publish } from "@/server/realtime";
import { engagementSourceToEnum, type EngagementSource } from "@/server/services/engagement-mode";
import {
  createOrchestrationContextSnapshot,
  loadIssueOrchestrationContext,
  type IssueOrchestrationContext,
} from "@/server/services/orchestration-context";
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

const OUTPUT_EVENT_KINDS = new Set(["COMMENT", "STATUS", "TRANSITION", "STEP", "TOOL_CALL"]);

/**
 * Lightweight SSE-only publish. Used for high-frequency STEP / TOOL
 * events where we don't want to spam the AuditLog + ActivityEvent
 * tables. Mirrors the RealtimeEvent shape the browser already knows
 * how to consume (subjectType + subjectId + payload + kind).
 */
function publishRunEvent(params: {
  eventId?: string;
  createdAt?: Date;
  workspaceId: string;
  kind: EventKind;
  runId: string;
  issueId: string;
  agentId: string;
  payload?: Record<string, unknown>;
}): void {
  void publish({
    id: params.eventId ?? nanoid(),
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
    createdAt: (params.createdAt ?? new Date()).toISOString(),
  });
}

/**
 * Returns the active (non-terminal) run for this (issue, agent) tuple,
 * or null. There can be at most one non-terminal run per (issue, agent)
 * by convention — every call site goes through `openOrTouchRun()` which
 * enforces it.
 *
 * "Non-terminal" includes both ACTIVE and WAITING. A WAITING run is a
 * patient agent that's blocked on the operator. Incidental output touches
 * reuse it without resuming; only callers with explicit resume authority
 * may flip it ACTIVE, so a held run never becomes work because metadata or
 * an automated comment changed.
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
 * Touch an already-open run without creating one. Metadata transports such as
 * MCP comments use this boundary so a write can enrich explicit execution
 * provenance but can never manufacture execution provenance by itself.
 */
export async function touchActiveRun(
  tx: Tx,
  params: {
    issueId: string;
    agentId: string;
    connectionId?: string | null;
    lifecycleConfidence?: LivenessConfidence;
    currentStep?: string | null;
  },
): Promise<AgentRun | null> {
  const existing = await findActiveRun(tx, params);
  if (!existing) return null;
  const preserveParkedWaiting = existing.status === AgentRunStatus.WAITING;
  const claimed = await tx.agentRun.updateMany({
    where: {
      id: existing.id,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
    },
    data: {
      ...(!preserveParkedWaiting ? { lastEventAt: new Date() } : {}),
      ...(params.currentStep !== undefined ? { currentStep: params.currentStep } : {}),
      ...(params.connectionId && !existing.connectionId
        ? {
            connectionId: params.connectionId,
            ...(params.lifecycleConfidence
              ? { lifecycleConfidence: params.lifecycleConfidence }
              : {}),
          }
        : {}),
    },
  });
  if (claimed.count !== 1) return null;
  return tx.agentRun.findUnique({ where: { id: existing.id } });
}

/**
 * Collapse stacked attempts. When a *fresh* run opens for (issue, agent),
 * link the prior STALLED attempts to it via `supersededByRunId` so operator
 * surfaces render one thread (newest run, with an "N earlier attempts"
 * affordance) instead of N repeated cards — the AXI-75 pathology where a
 * re-dispatch kept creating new ACTIVE runs while dead STALLED ones piled up.
 *
 * The superseded runs keep their own terminal status for history; surfaces
 * filter on `supersededByRunId: null` to show only the head of each chain.
 * ACTIVE/WAITING runs are never touched here (there is at most one, and
 * `openOrTouchRun` reuses it rather than opening a fresh run). Returns the
 * count linked; cheap no-op when there are none.
 */
export async function linkSupersededRuns(
  tx: Tx,
  params: { workspaceId: string; issueId: string; agentId: string; newRunId: string },
): Promise<number> {
  const priors = await tx.agentRun.findMany({
    where: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      id: { not: params.newRunId },
      supersededByRunId: null,
      status: AgentRunStatus.STALLED,
    },
    select: { id: true },
  });
  if (priors.length === 0) return 0;

  await tx.agentRun.updateMany({
    where: { id: { in: priors.map((r) => r.id) } },
    data: { supersededByRunId: params.newRunId },
  });
  // Quiet timeline markers only — no `lastEventAt` bump / SSE step on a
  // dead run (it stays terminal); the chain link is the durable signal.
  for (const prior of priors) {
    await tx.agentRunEvent.create({
      data: {
        workspaceId: params.workspaceId,
        runId: prior.id,
        kind: "SUPERSEDED",
        payload: { supersededByRunId: params.newRunId },
      },
    });
  }
  return priors.length;
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
    /** Concrete runtime/MCP/webhook endpoint responsible for this attempt. */
    connectionId?: string | null;
    lifecycleConfidence?: LivenessConfidence;
    assignmentEventId?: string | null;
    currentStep?: string | null;
    /** Set when the run executes a Goal-orchestration ExecutionStep (AXI-57). */
    executionStepId?: string | null;
    /** Engagement mode for this run (AXI-53). Defaults EXECUTE when unset. */
    engagementMode?: EngagementMode | null;
    /** How `engagementMode` was resolved (Phase 2). Frozen for the tooltip. */
    engagementSource?: EngagementSource | null;
    /** Effective run engine resolved at dispatch (Phase 2). Frozen on the run. */
    runEngine?: RunEngine | null;
    /** Free-form provenance for `runEngine` (display-only). */
    runEngineSource?: string | null;
    /** Dispatch-time runtime/tool policy snapshot. */
    runtimePolicy?: Prisma.InputJsonValue | null;
    /**
     * Context already loaded by a dispatch caller. Undefined hydrates it at
     * this canonical boundary; null explicitly records that none was present.
     */
    orchestrationContext?: IssueOrchestrationContext | null;
    /** Latest ActivityEvent that woke this run. */
    triggerEventId?: string | null;
    /** String mirror of ActivityEvent.kind for the latest wake. */
    triggerKind?: string | null;
    /**
     * Explicit authority to move a parked WAITING run back to ACTIVE.
     * Output/status touches leave this false; assignments, agent-owned
     * transitions, and operator resume controls set it true. Human replies
     * for RUNS engines stay WAITING until resumeWaitingRuns starts a fresh
     * provider turn with the reply context.
     */
    resumeWaiting?: boolean;
  },
): Promise<{ run: AgentRun; isNew: boolean }> {
  const existing = await findActiveRun(tx, {
    issueId: params.issueId,
    agentId: params.agentId,
  });

  const orchestrationContext =
    existing?.orchestrationContextSnapshot != null
      ? null
      : params.orchestrationContext !== undefined
        ? params.orchestrationContext
        : await loadIssueOrchestrationContext(tx, {
            workspaceId: params.workspaceId,
            issueId: params.issueId,
            executionStepId: params.executionStepId,
          });
  const orchestrationContextSnapshot = orchestrationContext
    ? createOrchestrationContextSnapshot(orchestrationContext)
    : null;

  if (existing) {
    // Auto-resume WAITING runs: a fresh action on a WAITING run is
    // strong evidence the agent is back on the loop. Flip to ACTIVE
    // and bump `lastEventAt` so the stale watchdog restarts fresh.
    // Conscious choice not to emit a separate event here — the
    // triggering caller (comment.create, MCP write, etc.) already
    // records its own audit row.
    const resumeAuthorized = params.resumeWaiting ?? Boolean(params.assignmentEventId);
    const resumeFromWaiting = existing.status === AgentRunStatus.WAITING && resumeAuthorized;
    const preserveParkedWaiting = existing.status === AgentRunStatus.WAITING && !resumeFromWaiting;
    // Re-arm run-budget enforcement when a paused run resumes. Inlined (not
    // imported from run-budget.ts) to avoid a module cycle — run-budget
    // already imports this file. No-op unless a budget breach/warn marker is
    // present, so normal WAITING resumes are unaffected.
    let rearmMeta: Prisma.InputJsonValue | undefined;
    if (
      resumeFromWaiting &&
      existing.completionMeta &&
      typeof existing.completionMeta === "object"
    ) {
      const m = { ...(existing.completionMeta as Record<string, unknown>) };
      if (m.budget && typeof m.budget === "object") {
        const b = { ...(m.budget as Record<string, unknown>) };
        if (b.breachedAt !== undefined || b.warnedAt !== undefined) {
          delete b.breachedAt;
          delete b.breachedMetric;
          delete b.warnedAt;
          delete b.warnedMetric;
          delete b.stopped;
          b.rearmedAt = new Date().toISOString();
          m.budget = b;
          rearmMeta = m as Prisma.InputJsonValue;
        }
      }
    }
    const updated = await tx.agentRun.update({
      where: { id: existing.id },
      data: {
        ...(!preserveParkedWaiting ? { lastEventAt: new Date() } : {}),
        ...(resumeFromWaiting
          ? { status: AgentRunStatus.ACTIVE, controlState: "NONE", controlRequestedAt: null }
          : {}),
        ...(rearmMeta !== undefined ? { completionMeta: rearmMeta } : {}),
        ...(params.assignmentEventId && !existing.assignmentEventId
          ? { assignmentEventId: params.assignmentEventId }
          : {}),
        // Re-stamp the engagement mode + source ONLY on a fresh assignment
        // (the same gate as assignmentEventId backfill). Incidental touches
        // (comment wake, MCP write) must NOT clobber it — that is exactly the
        // sticky-active-run tier the inbox relies on. (Phase 2)
        ...(params.assignmentEventId && !existing.assignmentEventId && params.engagementMode
          ? {
              engagementMode: params.engagementMode,
              ...(params.engagementSource
                ? { engagementSource: engagementSourceToEnum(params.engagementSource) }
                : {}),
            }
          : {}),
        // Engine is an agent/runtime fact, not a per-dispatch intent — backfill
        // it the first time we know it and leave it stable thereafter.
        ...(params.runEngine && !existing.runEngine
          ? { runEngine: params.runEngine, runEngineSource: params.runEngineSource ?? null }
          : {}),
        ...(params.currentStep !== undefined ? { currentStep: params.currentStep } : {}),
        ...(params.runtimePolicy && !existing.runtimePolicy
          ? { runtimePolicy: params.runtimePolicy }
          : {}),
        ...(orchestrationContextSnapshot && !existing.orchestrationContextSnapshot
          ? { orchestrationContextSnapshot }
          : {}),
        ...(params.triggerEventId !== undefined ? { triggerEventId: params.triggerEventId } : {}),
        ...(params.triggerKind !== undefined ? { triggerKind: params.triggerKind } : {}),
        // Ownership is sticky for a live attempt. Activity from another
        // endpoint may be recorded on its event, but cannot silently take over
        // the run that an existing connection opened.
        ...(params.connectionId && !existing.connectionId
          ? {
              connectionId: params.connectionId,
              ...(params.lifecycleConfidence
                ? { lifecycleConfidence: params.lifecycleConfidence }
                : {}),
            }
          : {}),
      },
    });
    return { run: updated, isNew: false };
  }

  const run = await tx.agentRun.create({
    data: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      connectionId: params.connectionId ?? null,
      ...(params.lifecycleConfidence ? { lifecycleConfidence: params.lifecycleConfidence } : {}),
      status: AgentRunStatus.ACTIVE,
      assignmentEventId: params.assignmentEventId ?? null,
      currentStep: params.currentStep ?? null,
      executionStepId: params.executionStepId ?? null,
      triggerEventId: params.triggerEventId ?? null,
      triggerKind: params.triggerKind ?? null,
      ...(params.engagementMode ? { engagementMode: params.engagementMode } : {}),
      ...(params.engagementSource
        ? { engagementSource: engagementSourceToEnum(params.engagementSource) }
        : {}),
      ...(params.runEngine
        ? { runEngine: params.runEngine, runEngineSource: params.runEngineSource ?? null }
        : {}),
      ...(params.runtimePolicy ? { runtimePolicy: params.runtimePolicy } : {}),
      ...(orchestrationContextSnapshot ? { orchestrationContextSnapshot } : {}),
    },
  });

  // Stamp the opening AgentRunEvent so the timeline starts with a
  // STARTED row even before any subsequent step / status update.
  await tx.agentRunEvent.create({
    data: {
      workspaceId: params.workspaceId,
      runId: run.id,
      connectionId: params.connectionId ?? null,
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

  // Collapse any prior STALLED attempts for this (issue, agent) under the
  // freshly-opened run so the operator sees one thread, not a pile.
  await linkSupersededRuns(tx, {
    workspaceId: params.workspaceId,
    issueId: params.issueId,
    agentId: params.agentId,
    newRunId: run.id,
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
    /** Internal operator audit events may be appended without reviving terminal UI state. */
    allowTerminal?: boolean;
    /** Endpoint that emitted this event; may differ from the run owner. */
    connectionId?: string | null;
  },
): Promise<void> {
  const now = new Date();
  // Terminal rows are immutable from the operator's point of view. Provider
  // subscriptions can deliver a buffered thinking/tool event after
  // `runs.complete` has already closed the run; claim the live row first so
  // that late event cannot put a COMPLETED card back into "thinking".
  const live = await tx.agentRun.updateMany({
    where: {
      id: params.runId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
    },
    data: {
      lastEventAt: now,
    },
  });
  if (live.count === 0 && !params.allowTerminal) return;

  // Once a run is deliberately parked, its reason is the operator-facing
  // truth. Buffered provider progress may still arrive and belongs in the
  // trace, but it must not replace that reason with a generic "thinking" or
  // tool label.
  if (live.count > 0 && params.currentStep !== undefined) {
    await tx.agentRun.updateMany({
      where: { id: params.runId, status: AgentRunStatus.ACTIVE },
      data: { currentStep: params.currentStep },
    });
  }

  if (live.count === 0) {
    const terminal = await tx.agentRun.findFirst({
      where: { id: params.runId, workspaceId: params.workspaceId },
      select: { id: true },
    });
    if (!terminal) return;
  }

  const event = await tx.agentRunEvent.create({
    data: {
      workspaceId: params.workspaceId,
      runId: params.runId,
      connectionId: params.connectionId ?? null,
      kind: params.kind,
      payload: params.payload ?? Prisma.JsonNull,
    },
  });
  if (live.count > 0 && OUTPUT_EVENT_KINDS.has(params.kind)) {
    await tx.agentRun.updateMany({
      where: { id: params.runId, outputStartedAt: null },
      data: { outputStartedAt: now },
    });
  }

  // Lightweight SSE-only publish — no AuditLog row, no ActivityEvent
  // row. The events table is the durable timeline; this is just for the
  // live strip to react in real time.
  publishRunEvent({
    eventId: event.id,
    createdAt: event.createdAt,
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
 * Idempotent: concurrent or repeated finish attempts return the terminal row
 * without duplicating comments, terminal events, or audit activity.
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
  const existing = await tx.agentRun.findFirst({
    where: {
      id: params.runId,
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
    },
  });
  if (!existing) return null;
  if (existing.status !== AgentRunStatus.ACTIVE && existing.status !== AgentRunStatus.WAITING) {
    return existing;
  }

  const now = new Date();
  // Claim the live row before producing any terminal side effect. Competing
  // completion paths can otherwise both observe ACTIVE and create duplicate
  // final comments before either writes the terminal status.
  const claimed = await tx.agentRun.updateMany({
    where: {
      id: params.runId,
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
    },
    data: {
      status: AgentRunStatus[params.status],
      finishedAt: now,
      // `completedAt` marks a *clean* completion only — never set for
      // STALLED/ABANDONED. Rollups that mean "succeeded" key off this,
      // not `finishedAt` (which is stamped for any terminal transition).
      ...(params.status === "COMPLETED" ? { completedAt: now } : {}),
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
      // Live-only presentation state must not survive a terminal transition.
      // In particular this prevents COMPLETED · thinking · LIVE cards when a
      // provider flushes a buffered trace event around completion.
      currentStep: null,
      awaitingApprovalAt: null,
      pendingApproval: Prisma.DbNull,
      controlState: "NONE",
      controlRequestedAt: null,
      controlRequestedById: null,
      executionCapabilityHash: null,
    },
  });
  if (claimed.count !== 1) {
    return tx.agentRun.findFirst({
      where: {
        id: params.runId,
        workspaceId: params.workspaceId,
        issueId: params.issueId,
        agentId: params.agentId,
      },
    });
  }

  // Every terminal run gets exactly one durable issue comment. Keeping this
  // inside the row-claim boundary makes failure comments idempotent too: two
  // polling workers can observe the same provider terminal state, but only the
  // winner above reaches this side effect. Previously the dispatcher posted a
  // STALLED comment after finishRun returned, so a race could post twice and
  // each comment could self-wake the same agent.
  const completionMeta =
    existing.completionMeta &&
    typeof existing.completionMeta === "object" &&
    !Array.isArray(existing.completionMeta)
      ? { ...(existing.completionMeta as Record<string, unknown>) }
      : {};
  const knownTerminalCommentId =
    typeof completionMeta.terminalCommentId === "string"
      ? completionMeta.terminalCommentId
      : params.status === "COMPLETED" && typeof completionMeta.completionCommentId === "string"
        ? completionMeta.completionCommentId
        : null;
  if (!knownTerminalCommentId) {
    const summary = params.summary?.trim() || existing.summary?.trim();
    const body =
      params.status === "COMPLETED"
        ? summary || "Run completed."
        : params.status === "STALLED"
          ? `[dispatch · run stalled]\n\n${summary || "The run stopped making progress before it completed."}`
          : `[dispatch · run abandoned]\n\n${summary || "The run was stopped before it completed."}`;
    const comment = await postAgentRunComment(tx, {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      body,
    });
    completionMeta.terminalCommentId = comment.id;
    if (params.status === "COMPLETED") completionMeta.completionCommentId = comment.id;
  }
  const finished = await tx.agentRun.update({
    where: { id: params.runId },
    data: { completionMeta: completionMeta as Prisma.InputJsonValue },
  });

  await tx.actionRequest.updateMany({
    where: {
      workspaceId: params.workspaceId,
      status: ActionRequestStatus.OPEN,
      dedupeKey: `agent-run-waiting:${params.runId}`,
    },
    data: {
      status: ActionRequestStatus.RESOLVED,
      resolvedAt: now,
      resolution:
        params.status === "COMPLETED"
          ? "Run completed."
          : params.status === "ABANDONED"
            ? "Run abandoned."
            : "Run stalled and moved to recovery.",
    },
  });

  await tx.agentRunEvent.create({
    data: {
      workspaceId: params.workspaceId,
      runId: params.runId,
      connectionId: existing.connectionId,
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
 * Post an issue comment authored AS the agent, on behalf of a dispatched run.
 *
 * The RUNS-engine dispatcher owns the agent loop over the connector socket.
 * A provider that lacks Forge MCP — or that finishes without calling
 * `comments.create` itself — can otherwise leave its output orphaned in
 * `AgentRun.summary`, visible only in the run overlay. Successful completions
 * use this helper as a shared final-comment guarantee; terminal failures use
 * it when the dispatcher needs to surface output. Authored with
 * `authoringAgentId` and a null human author so the UI renders the agent as
 * the speaker.
 */
export async function postAgentRunComment(
  tx: Tx,
  params: {
    workspaceId: string;
    issueId: string;
    agentId: string;
    body: string;
  },
): Promise<{ id: string }> {
  const comment = await tx.comment.create({
    data: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      authorId: null,
      authoringAgentId: params.agentId,
      body: params.body,
    },
  });
  await recordChange(tx, {
    workspaceId: params.workspaceId,
    actorId: null,
    actorAgentId: params.agentId,
    entity: "Comment",
    entityId: comment.id,
    action: "create",
    after: comment,
    eventKind: EventKind.COMMENT_CREATED,
    subjectType: "issue",
    subjectId: params.issueId,
    payload: {
      commentId: comment.id,
      issueId: params.issueId,
      agentId: params.agentId,
      preview: params.body.slice(0, 120),
    },
  });
  return { id: comment.id };
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
    resumeWaiting?: boolean;
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
    resumeWaiting: params.resumeWaiting ?? false,
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
    where: {
      issueId: params.issueId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
    },
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

/**
 * Close active work for an agent that no longer owns the issue.
 * Reassignment should leave that work as chronological history, not as a
 * live/pinned status card competing with the new assignee.
 */
export async function abandonRunsForAgentReassignment(
  tx: Tx,
  params: {
    workspaceId: string;
    issueId: string;
    agentId: string;
    actorId?: string | null;
    actorAgentId?: string | null;
    summary?: string | null;
  },
): Promise<number> {
  const active = await tx.agentRun.findMany({
    where: {
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: params.agentId,
      status: { in: [AgentRunStatus.ACTIVE, AgentRunStatus.WAITING] },
    },
    select: { id: true, agentId: true },
  });

  for (const run of active) {
    await finishRun(tx, {
      runId: run.id,
      workspaceId: params.workspaceId,
      issueId: params.issueId,
      agentId: run.agentId,
      status: "ABANDONED",
      summary:
        params.summary ?? "Abandoned because this issue was reassigned before the run completed.",
      actorId: params.actorId ?? null,
      actorAgentId: params.actorAgentId ?? null,
    });
  }

  return active.length;
}
