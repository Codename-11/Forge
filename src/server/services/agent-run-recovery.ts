import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { AgentRunStatus, EventKind } from "@prisma/client";
import { recordChange } from "@/server/audit";
import { appendRunEvent, finishRun } from "@/server/services/agent-run";
import { STALE_RUN_MS } from "@/server/services/agent-presence";
import {
  runProtocolDiagnostics,
  type RunProtocolDiagnostic,
} from "@/server/services/run-protocol-diagnostics";

type Tx = PrismaClient | Prisma.TransactionClient;

export type RunRecoveryReason = "active-stale" | "terminal-failure" | "protocol-failed";

export type RunRecoveryAction = "ABANDON" | "CLEAR" | "RECONCILE";

export type RunRecoveryItem = {
  id: string;
  reason: RunRecoveryReason;
  severity: "warning" | "error";
  title: string;
  detail: string;
  idleMs: number;
  recommendedAction: RunRecoveryAction;
  availableActions: RunRecoveryAction[];
  diagnostics: RunProtocolDiagnostic[];
  run: AgentRunRecoveryRow;
};

export type RunRecoverySummary = {
  items: RunRecoveryItem[];
  counts: {
    total: number;
    activeStale: number;
    terminalFailures: number;
    protocolFailed: number;
  };
  scanned: number;
  truncated: boolean;
  staleMs: number;
};

const RECOVERY_SCAN_LIMIT = 500;

const runRecoverySelect = {
  id: true,
  workspaceId: true,
  issueId: true,
  agentId: true,
  status: true,
  startedAt: true,
  lastEventAt: true,
  finishedAt: true,
  currentStep: true,
  summary: true,
  engagementMode: true,
  engagementSource: true,
  runEngine: true,
  runEngineSource: true,
  acknowledgedAt: true,
  outputStartedAt: true,
  producedArtifactIds: true,
  verificationResult: true,
  followUps: true,
  completionMeta: true,
  runtimePolicy: true,
  clearedAt: true,
  awaitingApprovalAt: true,
  agent: {
    select: {
      id: true,
      name: true,
      profileKey: true,
      avatar: true,
      status: true,
      provider: true,
      runtime: {
        select: {
          id: true,
          name: true,
          kind: true,
          adapterKey: true,
          config: true,
          disabledAt: true,
          heartbeatAt: true,
          lastProbeAt: true,
          lastProbeAttempted: true,
          lastProbeReachable: true,
          lastProbeDetail: true,
          endpoint: true,
          archivedAt: true,
          connectedAt: true,
        },
      },
    },
  },
  issue: {
    select: {
      id: true,
      number: true,
      title: true,
      expectedOutput: true,
      verificationChecklist: true,
      artifactRequired: true,
      status: { select: { id: true, name: true, category: true, color: true } },
      workspace: { select: { key: true, slug: true } },
    },
  },
} satisfies Prisma.AgentRunSelect;

export type AgentRunRecoveryRow = Prisma.AgentRunGetPayload<{
  select: typeof runRecoverySelect;
}>;

function completionMetaRecord(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? ({ ...(value as Prisma.JsonObject) } as Prisma.JsonObject)
    : {};
}

function diagnosticsFor(run: AgentRunRecoveryRow, now: Date): RunProtocolDiagnostic[] {
  return runProtocolDiagnostics({
    run,
    issue: {
      expectedOutput: run.issue.expectedOutput,
      verificationChecklist: run.issue.verificationChecklist,
      artifactRequired: run.issue.artifactRequired,
    },
    now,
    staleMs: STALE_RUN_MS,
  });
}

export function classifyRunForRecovery(
  run: AgentRunRecoveryRow,
  now = new Date(),
): RunRecoveryItem | null {
  if (run.clearedAt) return null;
  const lastEventAt = run.lastEventAt instanceof Date ? run.lastEventAt : new Date(run.lastEventAt);
  const idleMs = Math.max(0, now.getTime() - lastEventAt.getTime());
  const diagnostics = diagnosticsFor(run, now);
  const errorDiagnostic = diagnostics.find((d) => d.severity === "error") ?? null;
  const warningDiagnostic = diagnostics.find((d) => d.severity === "warning") ?? null;

  if (run.status === "COMPLETED" && errorDiagnostic) {
    return {
      id: run.id,
      reason: "protocol-failed",
      severity: "error",
      title: "Protocol-failed completion",
      detail: errorDiagnostic.description,
      idleMs,
      recommendedAction: "RECONCILE",
      availableActions: ["RECONCILE"],
      diagnostics,
      run,
    };
  }

  if (run.status === "STALLED" || run.status === "ABANDONED") {
    return {
      id: run.id,
      reason: "terminal-failure",
      severity: run.status === "STALLED" ? "error" : "warning",
      title: run.status === "STALLED" ? "Stalled terminal run" : "Abandoned terminal run",
      detail:
        run.summary ??
        (run.status === "STALLED"
          ? "The watchdog or operator marked this run stalled."
          : "The run was abandoned before a clean completion."),
      idleMs,
      recommendedAction: "CLEAR",
      availableActions: ["CLEAR"],
      diagnostics,
      run,
    };
  }

  // WAITING is a deliberate patient-agent state, not generic stale work.
  // Questions and approvals surface through their dedicated attention rows;
  // listing a quiet wait again as a "stalled run" duplicates the operator
  // card and invites an incorrect abandon action.
  if (run.status === "ACTIVE" && !run.awaitingApprovalAt && idleMs >= STALE_RUN_MS) {
    const detail =
      warningDiagnostic?.description ??
      "The run is active but has not emitted a recent AgentRunEvent.";
    return {
      id: run.id,
      reason: "active-stale",
      severity: "warning",
      title: warningDiagnostic?.title ?? "Active run is stale",
      detail,
      idleMs,
      recommendedAction: "ABANDON",
      availableActions: ["ABANDON"],
      diagnostics,
      run,
    };
  }

  return null;
}

export async function listRunRecoveryItems(
  db: Tx,
  input: {
    workspaceId: string;
    includeCleared?: boolean;
    limit?: number;
    now?: Date;
  },
): Promise<RunRecoverySummary> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const scanLimit = Math.min(RECOVERY_SCAN_LIMIT, Math.max(limit * 5, 100));
  const rows = await db.agentRun.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.includeCleared ? {} : { clearedAt: null }),
      // Collapse stacked attempts: a run that a newer one superseded is
      // hidden here so the AXI-75 pattern (N STALLED rows for one piece of
      // work) renders as a single card — the chain head. History is intact
      // (the rows keep their status); the detail overlay walks the chain.
      supersededByRunId: null,
      status: {
        in: [
          AgentRunStatus.ACTIVE,
          AgentRunStatus.WAITING,
          AgentRunStatus.STALLED,
          AgentRunStatus.ABANDONED,
          AgentRunStatus.COMPLETED,
        ],
      },
    },
    orderBy: [{ lastEventAt: "desc" }, { startedAt: "desc" }],
    take: scanLimit,
    select: runRecoverySelect,
  });

  const all = rows
    .map((row) => classifyRunForRecovery(row, now))
    .filter((row): row is RunRecoveryItem => !!row)
    .sort((a, b) => {
      const severity = (v: RunRecoveryItem) => (v.severity === "error" ? 0 : 1);
      const sev = severity(a) - severity(b);
      if (sev !== 0) return sev;
      return b.idleMs - a.idleMs;
    });
  const items = all.slice(0, limit);

  return {
    items,
    counts: {
      total: all.length,
      activeStale: all.filter((item) => item.reason === "active-stale").length,
      terminalFailures: all.filter((item) => item.reason === "terminal-failure").length,
      protocolFailed: all.filter((item) => item.reason === "protocol-failed").length,
    },
    scanned: rows.length,
    truncated: all.length > limit || rows.length === scanLimit,
    staleMs: STALE_RUN_MS,
  };
}

async function clearRun(
  tx: Tx,
  input: {
    run: Pick<AgentRunRecoveryRow, "id" | "issueId" | "agentId" | "status" | "clearedAt">;
    workspaceId: string;
    actorId: string;
    actorAgentId?: string | null;
    action: "clear" | "reconcile" | "abandon-clear";
    payload?: Prisma.InputJsonValue;
  },
): Promise<void> {
  const clearedAt = new Date();
  await tx.agentRun.update({
    where: { id: input.run.id },
    data: {
      clearedAt,
      clearedById: input.actorId,
    },
  });
  await recordChange(tx, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorAgentId: input.actorAgentId ?? null,
    entity: "AgentRun",
    entityId: input.run.id,
    action: input.action,
    before: { status: input.run.status, clearedAt: input.run.clearedAt },
    after: { status: input.run.status, clearedAt: clearedAt.toISOString() },
    eventKind: EventKind.AGENT_RUN_CLEARED,
    subjectType: "agent-run",
    subjectId: input.run.id,
    payload: {
      runId: input.run.id,
      issueId: input.run.issueId,
      agentId: input.run.agentId,
      status: input.run.status,
      clearedAt: clearedAt.toISOString(),
      recoveryAction: input.action,
      ...(input.payload && typeof input.payload === "object" ? (input.payload as object) : {}),
    },
  });
}

export async function recoverAgentRuns(
  db: PrismaClient,
  input: {
    workspaceId: string;
    actorId: string;
    actorAgentId?: string | null;
    runIds: string[];
    action: RunRecoveryAction;
    summary?: string | null;
  },
): Promise<{
  ok: true;
  action: RunRecoveryAction;
  changed: number;
  skipped: Array<{ runId: string; reason: string }>;
  runIds: string[];
}> {
  const uniqueIds = Array.from(new Set(input.runIds)).slice(0, 100);
  const changed: string[] = [];
  const skipped: Array<{ runId: string; reason: string }> = [];
  await db.$transaction(async (tx) => {
    const rows = await tx.agentRun.findMany({
      where: {
        id: { in: uniqueIds },
        workspaceId: input.workspaceId,
      },
      select: runRecoverySelect,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const now = new Date();

    for (const runId of uniqueIds) {
      const run = byId.get(runId);
      if (!run) {
        skipped.push({ runId, reason: "not found" });
        continue;
      }
      const item = classifyRunForRecovery(run, now);
      if (!item) {
        skipped.push({ runId, reason: "not recoverable" });
        continue;
      }

      if (input.action === "CLEAR") {
        if (run.status !== "STALLED" && run.status !== "ABANDONED") {
          skipped.push({ runId, reason: "clear only applies to stalled or abandoned runs" });
          continue;
        }
        await clearRun(tx, {
          run: { ...run, status: AgentRunStatus.ABANDONED },
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorAgentId: input.actorAgentId,
          action: "clear",
        });
        changed.push(run.id);
        continue;
      }

      if (input.action === "RECONCILE") {
        if (item.reason !== "protocol-failed") {
          skipped.push({ runId, reason: "reconcile only applies to protocol-failed completions" });
          continue;
        }
        const reconciledAt = new Date().toISOString();
        const completionMeta = completionMetaRecord(run.completionMeta);
        completionMeta.protocolReconciledAt = reconciledAt;
        completionMeta.protocolReconciledById = input.actorId;
        completionMeta.protocolReconciledReason =
          input.summary ?? "Operator reconciled the protocol-failed completion.";
        await tx.agentRun.update({
          where: { id: run.id },
          data: { completionMeta },
        });
        await appendRunEvent(tx, {
          runId: run.id,
          workspaceId: input.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          kind: "RECONCILED",
          payload: {
            reason: input.summary ?? null,
            diagnostics: item.diagnostics,
          },
          currentStep: "reconciled by operator",
        });
        await clearRun(tx, {
          run,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorAgentId: input.actorAgentId,
          action: "reconcile",
          payload: { diagnostics: item.diagnostics },
        });
        changed.push(run.id);
        continue;
      }

      if (input.action === "ABANDON") {
        if (run.status !== "ACTIVE" && run.status !== "WAITING") {
          skipped.push({ runId, reason: "abandon only applies to active or waiting runs" });
          continue;
        }
        await finishRun(tx, {
          runId: run.id,
          workspaceId: input.workspaceId,
          issueId: run.issueId,
          agentId: run.agentId,
          status: "ABANDONED",
          summary:
            input.summary ??
            `Operator abandoned stale run after ${Math.round(item.idleMs / 60_000)}m without activity.`,
          actorId: input.actorId,
          actorAgentId: input.actorAgentId ?? null,
        });
        await clearRun(tx, {
          run,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorAgentId: input.actorAgentId,
          action: "abandon-clear",
          payload: { staleMs: item.idleMs },
        });
        changed.push(run.id);
      }
    }
  });

  return {
    ok: true,
    action: input.action,
    changed: changed.length,
    skipped,
    runIds: changed,
  };
}
