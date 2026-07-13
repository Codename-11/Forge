import "server-only";
import type { AgentRunStatus, EngagementMode, Prisma } from "@prisma/client";
import {
  validateRunCompletion,
  type IssueCompletionContract,
  type RunCompletionInput,
  type RunCompletionConfidence,
  type RunReviewVerdict,
  type RunVerificationResultItem,
} from "@/server/services/run-completion-contract";

export type RunProtocolDiagnosticCode =
  | "never-acked"
  | "acked-no-output"
  | "progress-unreported"
  | "progress-quiet"
  | "completion-missing"
  | "completed-invalid";

export type RunProtocolDiagnostic = {
  code: RunProtocolDiagnosticCode;
  severity: "info" | "warning" | "error";
  title: string;
  description: string;
};

const DEFAULT_STALE_MS = 5 * 60_000;

export type RunProtocolSignalState =
  | "MISSING"
  | "PENDING"
  | "RECORDED"
  | "CURRENT"
  | "QUIET"
  | "WAITING"
  | "FAILED"
  | "UNKNOWN";

export type RunProtocolSignal = {
  state: RunProtocolSignalState;
  at: Date | null;
};

export type RunProtocolSignals = {
  acknowledgement: RunProtocolSignal;
  output: RunProtocolSignal;
  /** Semantic operator checkpoint, deliberately separate from mechanical events. */
  progress: RunProtocolSignal;
  completion: RunProtocolSignal;
};

type RunForDiagnostics = {
  status: AgentRunStatus;
  engagementMode: EngagementMode;
  acknowledgedAt?: Date | string | null;
  outputStartedAt?: Date | string | null;
  lastEventAt: Date | string;
  summary?: string | null;
  producedArtifactIds?: string[] | null;
  verificationResult?: Prisma.JsonValue | null;
  followUps?: Prisma.JsonValue | null;
  completionMeta?: Prisma.JsonValue | null;
  /**
   * Undefined means the caller did not load semantic-status data. Null means it
   * loaded the relation and the agent has not posted a checkpoint.
   */
  statusComment?: { updatedAt: Date | string } | null;
};

function dateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * Derive each run-protocol signal independently so clients do not have to
 * infer protocol health from one overloaded "stale" flag. Mechanical event
 * freshness (`lastEventAt`) never makes semantic progress current; only the
 * rolling STATUS comment does that.
 */
export function deriveRunProtocolSignals(input: {
  run: RunForDiagnostics;
  now?: Date;
  /** Timed semantic-checkpoint reminder. Zero disables timed progress warnings. */
  progressUpdateMs?: number;
  /** @deprecated Use progressUpdateMs. */
  quietMs?: number;
}): RunProtocolSignals {
  const { run } = input;
  const now = input.now ?? new Date();
  const progressUpdateMs = input.progressUpdateMs ?? input.quietMs ?? DEFAULT_STALE_MS;
  const acknowledgedAt = dateValue(run.acknowledgedAt);
  const outputStartedAt = dateValue(run.outputStartedAt);
  const lastEventAt = dateValue(run.lastEventAt);
  const checkpointAt = dateValue(run.statusComment?.updatedAt);
  const terminal =
    run.status === "COMPLETED" || run.status === "ABANDONED" || run.status === "STALLED";

  const acknowledgement: RunProtocolSignal = acknowledgedAt
    ? { state: "RECORDED", at: acknowledgedAt }
    : { state: "MISSING", at: null };
  const output: RunProtocolSignal = outputStartedAt
    ? { state: "RECORDED", at: outputStartedAt }
    : { state: acknowledgedAt ? "MISSING" : "PENDING", at: null };

  let progress: RunProtocolSignal;
  if (run.status === "WAITING") {
    progress = { state: "WAITING", at: lastEventAt };
  } else if (terminal) {
    progress = checkpointAt
      ? { state: "RECORDED", at: checkpointAt }
      : { state: run.statusComment === undefined ? "UNKNOWN" : "MISSING", at: null };
  } else if (!outputStartedAt) {
    progress = { state: "PENDING", at: null };
  } else if (run.statusComment === undefined) {
    progress = { state: "UNKNOWN", at: null };
  } else if (progressUpdateMs <= 0) {
    progress = checkpointAt
      ? { state: "RECORDED", at: checkpointAt }
      : { state: "UNKNOWN", at: null };
  } else if (!checkpointAt) {
    progress = {
      state:
        now.getTime() - outputStartedAt.getTime() >= progressUpdateMs ? "MISSING" : "PENDING",
      at: null,
    };
  } else {
    progress = {
      state: now.getTime() - checkpointAt.getTime() >= progressUpdateMs ? "QUIET" : "CURRENT",
      at: checkpointAt,
    };
  }

  let completion: RunProtocolSignal;
  if (run.status === "COMPLETED") {
    completion = { state: "RECORDED", at: lastEventAt };
  } else if (run.status === "STALLED" || run.status === "ABANDONED") {
    completion = { state: "FAILED", at: lastEventAt };
  } else {
    completion = { state: "PENDING", at: null };
  }

  return { acknowledgement, output, progress, completion };
}

function arrayValue(value: Prisma.JsonValue | null | undefined): unknown[] {
  return Array.isArray(value) ? value : [];
}

function completionMetaRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function completionInput(run: RunForDiagnostics): RunCompletionInput {
  const meta = completionMetaRecord(run.completionMeta);
  const confidence =
    typeof meta.confidence === "string" ? (meta.confidence as RunCompletionConfidence) : undefined;
  const verdict = typeof meta.verdict === "string" ? (meta.verdict as RunReviewVerdict) : undefined;
  return {
    summary: run.summary ?? undefined,
    producedArtifactIds: run.producedArtifactIds ?? undefined,
    verificationResult: arrayValue(run.verificationResult) as RunVerificationResultItem[],
    followUps: arrayValue(run.followUps) as Array<{ title: string; body?: string; kind?: string }>,
    confidence,
    verdict,
  };
}

export function runProtocolDiagnostics(input: {
  run: RunForDiagnostics;
  issue?: IssueCompletionContract | null;
  now?: Date;
  /** Workspace semantic STATUS cadence; zero disables timed progress warnings. */
  progressUpdateMs?: number;
  /** Workspace quiet-run threshold used for possible missing completion. */
  quietMs?: number;
  /** @deprecated Backward-compatible alias for quietMs. */
  staleMs?: number;
}): RunProtocolDiagnostic[] {
  const run = input.run;
  const out: RunProtocolDiagnostic[] = [];
  const inFlight = run.status === "ACTIVE" || run.status === "WAITING";
  const now = input.now ?? new Date();
  const quietMs = input.quietMs ?? input.staleMs ?? DEFAULT_STALE_MS;
  const progressUpdateMs = input.progressUpdateMs ?? DEFAULT_STALE_MS;
  const signals = deriveRunProtocolSignals({ run, now, progressUpdateMs });

  if (inFlight && !run.acknowledgedAt) {
    out.push({
      code: "never-acked",
      severity: "warning",
      title: "Never acknowledged",
      description: "Forge has an open run, but the agent has not acked the run protocol.",
    });
  } else if (inFlight && run.acknowledgedAt && !run.outputStartedAt) {
    out.push({
      code: "acked-no-output",
      severity: "warning",
      title: "Acked without output",
      description: "The agent acknowledged the run but has not reported output start.",
    });
  }

  if (inFlight && run.status !== "WAITING" && signals.progress.state === "MISSING") {
    out.push({
      code: "progress-unreported",
      severity: "warning",
      title: "Progress not reported",
      description:
        "The runtime is producing output, but the agent has not posted a semantic status checkpoint.",
    });
  } else if (inFlight && run.status !== "WAITING" && signals.progress.state === "QUIET") {
    out.push({
      code: "progress-quiet",
      severity: "warning",
      title: "Progress update is quiet",
      description:
        "The runtime may still be active, but its last operator-facing checkpoint is old.",
    });
  }

  if (inFlight && run.status !== "WAITING" && run.outputStartedAt) {
    const last = typeof run.lastEventAt === "string" ? new Date(run.lastEventAt) : run.lastEventAt;
    const idleMs = now.getTime() - last.getTime();
    if (quietMs > 0 && idleMs >= quietMs) {
      out.push({
        code: "completion-missing",
        severity: "warning",
        title: "Completion not recorded",
        description:
          "The run is quiet after output started and has not been closed with runs.complete. It is not canonically stalled until its status changes to STALLED.",
      });
    }
  }

  if (run.status === "COMPLETED" && input.issue) {
    const errors = validateRunCompletion({
      mode: run.engagementMode,
      issue: input.issue,
      completion: completionInput(run),
      issueLinkedArtifactIds: new Set(run.producedArtifactIds ?? []),
    });
    if (errors.length > 0) {
      out.push({
        code: "completed-invalid",
        severity: "error",
        title: "Completed without required output",
        description: errors.join(" "),
      });
    }
  }

  return out;
}
