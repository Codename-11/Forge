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
  | "output-not-completed"
  | "completed-invalid";

export type RunProtocolDiagnostic = {
  code: RunProtocolDiagnosticCode;
  severity: "info" | "warning" | "error";
  title: string;
  description: string;
};

const DEFAULT_STALE_MS = 5 * 60_000;

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
};

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
  const verdict =
    typeof meta.verdict === "string" ? (meta.verdict as RunReviewVerdict) : undefined;
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
  staleMs?: number;
}): RunProtocolDiagnostic[] {
  const run = input.run;
  const out: RunProtocolDiagnostic[] = [];
  const inFlight = run.status === "ACTIVE" || run.status === "WAITING";

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

  if (inFlight && run.outputStartedAt) {
    const last = typeof run.lastEventAt === "string" ? new Date(run.lastEventAt) : run.lastEventAt;
    const idleMs = (input.now ?? new Date()).getTime() - last.getTime();
    if (idleMs >= (input.staleMs ?? DEFAULT_STALE_MS)) {
      out.push({
        code: "output-not-completed",
        severity: "warning",
        title: "Output started, not completed",
        description: "The agent started producing output but has not closed the run with runs.complete.",
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

