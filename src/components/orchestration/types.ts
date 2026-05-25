/**
 * Orchestration view types + status palette.
 *
 * These mirror the schema contract for Goal / ExecutionPlan /
 * ExecutionStep that the orchestration backend ships. The viz layer
 * consumes them defensively (optional fields) so it renders the same
 * whether the backend has merged the full contract (judge verdicts,
 * retries, budgets) or just the base ExecutionPlan/Step columns.
 *
 * Do NOT widen these beyond what the contract declares — if the backend
 * adds a field, add it here as optional and the components pick it up.
 */

import type { AvailabilityModel } from "@/lib/transport-display";

export type StepStatus =
  | "TODO"
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "REVIEW"
  | "DONE"
  | "CANCELED";

export type JudgeVerdict = {
  verdict: "PASS" | "FAIL";
  feedback: string;
  score?: number | null;
  judgedByAgentId?: string | null;
  judgedAt: string;
};

export type DagAgent = {
  id: string;
  name: string;
  profileKey: string;
  status?: "ONLINE" | "BUSY" | "OFFLINE";
  avatar?: string | null;
  /** Availability model so on-demand agents read "on-demand", not "offline". */
  availability?: AvailabilityModel;
};

export type DagStep = {
  id: string;
  title: string;
  body?: string | null;
  position: number;
  status: StepStatus;
  assignedAgentId?: string | null;
  dependsOnStepIds: string[];
  expectedOutput?: string | null;
  judgeVerdict?: JudgeVerdict | null;
  retryCount?: number | null;
  lastFeedback?: string | null;
  /** Resolved from the step's sourceRun — Plans DAG cost + approval overlay. */
  costUsd?: number | null;
  awaitingApproval?: boolean;
  childPlanId?: string | null;
  sourceRunId?: string | null;
};

/**
 * Per-status visual treatment. Colors come from design tokens — never
 * hardcoded hex. The DAG reads `dot`/`ring`/`text`/`label` off this so
 * a palette shift in globals.css cascades through every node.
 *
 *   TODO     → muted (waiting)
 *   READY    → ember-soft (queued, ready to pick up)
 *   RUNNING  → ember + pulse (live)
 *   BLOCKED  → danger (deps unmet / failed)
 *   REVIEW   → amber/warning (awaiting judge)
 *   DONE     → success
 *   CANCELED → muted, strikethrough
 */
export const STEP_STATUS_STYLE: Record<
  StepStatus,
  {
    label: string;
    /** dot/pill fill */
    dot: string;
    /** node border / ring */
    ring: string;
    /** node title text treatment */
    text: string;
    /** pill text + bg classes */
    pill: string;
  }
> = {
  TODO: {
    label: "Todo",
    dot: "bg-muted-foreground/50",
    ring: "border-border",
    text: "text-muted-foreground",
    pill: "border-border bg-card text-muted-foreground",
  },
  READY: {
    label: "Ready",
    dot: "bg-ember/50",
    ring: "border-ember/30",
    text: "text-foreground",
    pill: "border-ember/30 bg-ember/10 text-ember",
  },
  RUNNING: {
    label: "Running",
    dot: "bg-ember",
    ring: "border-ember/60",
    text: "text-foreground",
    pill: "border-ember/40 bg-ember/15 text-ember",
  },
  BLOCKED: {
    label: "Blocked",
    dot: "bg-danger",
    ring: "border-danger/50",
    text: "text-foreground",
    pill: "border-danger/40 bg-danger/10 text-danger",
  },
  REVIEW: {
    label: "Review",
    dot: "bg-warning",
    ring: "border-warning/50",
    text: "text-foreground",
    pill: "border-warning/40 bg-warning/10 text-warning",
  },
  DONE: {
    label: "Done",
    dot: "bg-success",
    ring: "border-success/40",
    text: "text-muted-foreground",
    pill: "border-success/40 bg-success/10 text-success",
  },
  CANCELED: {
    label: "Canceled",
    dot: "bg-muted-foreground/40",
    ring: "border-border/60",
    text: "text-muted-foreground line-through",
    pill: "border-border/60 bg-card text-muted-foreground",
  },
};

/** A step is "active" (live execution path) when it's RUNNING. */
export function isStepActive(status: StepStatus): boolean {
  return status === "RUNNING";
}

/** Steps that count as finished for progress accounting. */
export function isStepDone(status: StepStatus): boolean {
  return status === "DONE";
}
