"use client";

import { useEffect, useState } from "react";
import type { AgentStatus } from "@prisma/client";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Pause,
  Radio,
} from "lucide-react";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { Avatar } from "@/components/ui/avatar";
import { RunTimeline } from "@/components/mission-control/run-timeline";
import { STALE_RUN_MS } from "@/lib/agent-stale";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { useRealtime } from "@/hooks/use-realtime";
import type { OrchestrationAttentionRun } from "./run-attention-panel";

export type OperationalPhase =
  | "QUEUED"
  | "DISPATCHED"
  | "ACKNOWLEDGED"
  | "WORKING"
  | "WAITING"
  | "STALLED"
  | "REVIEW"
  | "DONE"
  | "STOPPED";

export type RunOperationalState = {
  phase: OperationalPhase;
  label: string;
  detail: string;
  tone: string;
  live: boolean;
  needsAttention: boolean;
};

/** Keeps freshness labels and quiet-run detection moving without a new SSE event. */
export function useOperationalClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function deriveRunOperationalState(
  run: OrchestrationAttentionRun | null | undefined,
  stepStatus: string,
  now = Date.now(),
): RunOperationalState {
  if (stepStatus === "DONE") {
    return state("DONE", "Done", "Work accepted", "text-success bg-success/10", false, false);
  }
  if (stepStatus === "REVIEW") {
    return state(
      "REVIEW",
      "Needs review",
      "Completed work is waiting for a verdict",
      "text-warning bg-warning/10",
      false,
      true,
    );
  }
  if (stepStatus === "BLOCKED") {
    return state(
      "STALLED",
      "Blocked",
      "This step cannot progress",
      "text-warning bg-warning/10",
      false,
      true,
    );
  }
  if (!run) {
    return state(
      "QUEUED",
      stepStatus === "READY" ? "Queued" : "Not started",
      stepStatus === "READY" ? "Ready for agent pickup" : "Waiting on dependencies",
      "text-muted-foreground bg-subtle",
      false,
      false,
    );
  }
  if (run.status === "WAITING" || run.awaitingApprovalAt) {
    return state(
      "WAITING",
      "Waiting on you",
      run.awaitingApprovalAt ? "Runtime approval required" : "Agent requested operator input",
      "text-warning bg-warning/10",
      false,
      true,
    );
  }
  if (run.status === "STALLED") {
    return state(
      "STALLED",
      "Stalled",
      "The run stopped reporting progress",
      "text-warning bg-warning/10",
      false,
      true,
    );
  }
  if (run.status === "ABANDONED") {
    return state(
      "STOPPED",
      "Stopped",
      "The run ended before completion",
      "text-danger bg-danger/10",
      false,
      true,
    );
  }
  if (run.status === "COMPLETED") {
    return state(
      "REVIEW",
      "Run complete",
      "Waiting for the plan step to reconcile",
      "text-warning bg-warning/10",
      false,
      true,
    );
  }
  const quiet = run.lastEventAt ? now - new Date(run.lastEventAt).getTime() >= STALE_RUN_MS : false;
  if (quiet) {
    return state(
      "STALLED",
      "Quiet",
      "No run event in the last five minutes",
      "text-warning bg-warning/10",
      true,
      true,
    );
  }
  if (run.outputStartedAt) {
    return state(
      "WORKING",
      "Working",
      run.currentStep || "Agent is producing output",
      "text-ember bg-ember/10",
      true,
      false,
    );
  }
  if (run.acknowledgedAt) {
    return state(
      "ACKNOWLEDGED",
      "Acknowledged",
      run.currentStep || "Agent accepted the work",
      "text-ember bg-ember/10",
      true,
      false,
    );
  }
  return state(
    "DISPATCHED",
    "Dispatched",
    "Wake sent; waiting for acknowledgement",
    "text-ember bg-ember/10",
    true,
    false,
  );
}

function state(
  phase: OperationalPhase,
  label: string,
  detail: string,
  tone: string,
  live: boolean,
  needsAttention: boolean,
): RunOperationalState {
  return { phase, label, detail, tone, live, needsAttention };
}

const PHASE_ICON: Record<OperationalPhase, typeof Activity> = {
  QUEUED: Clock3,
  DISPATCHED: Radio,
  ACKNOWLEDGED: CheckCircle2,
  WORKING: Activity,
  WAITING: Pause,
  STALLED: AlertTriangle,
  REVIEW: AlertTriangle,
  DONE: CheckCircle2,
  STOPPED: AlertTriangle,
};

export function RunOperationalStatus({
  run,
  stepStatus,
  className,
  showTrace = true,
}: {
  run: OrchestrationAttentionRun | null | undefined;
  stepStatus: string;
  className?: string;
  showTrace?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const now = useOperationalClock();
  const utils = trpc.useUtils();
  const operational = deriveRunOperationalState(run, stepStatus, now);
  const Icon = PHASE_ICON[operational.phase];
  const events = trpc.agentRun.events.useQuery(
    { runId: run?.id ?? "", limit: 30 },
    { enabled: Boolean(run?.id && expanded), staleTime: 3_000 },
  );

  useRealtime(
    () => {
      if (run?.id && expanded) void utils.agentRun.events.invalidate({ runId: run.id });
    },
    {
      subjectType: "agent-run",
      subjectId: run?.id,
    },
  );

  return (
    <div className={cn("rounded-md border border-border bg-background/30", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-2">
        <span
          className={cn(
            "text-meta inline-flex items-center gap-1 rounded px-1.5 py-0.5",
            operational.tone,
          )}
        >
          <Icon className={cn("h-3 w-3", operational.live && "motion-safe:animate-pulse")} />
          {operational.label}
        </span>
        {run?.agent ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="relative inline-flex shrink-0">
              <Avatar name={run.agent.name} image={run.agent.avatar} size={18} />
              <AgentPresenceDot
                status={
                  (run.agent.status === "BUSY" || run.agent.status === "ONLINE"
                    ? run.agent.status
                    : "OFFLINE") as AgentStatus
                }
                className="absolute -bottom-0.5 -right-0.5 ring-1 ring-card"
              />
            </span>
            <span className="text-id truncate font-mono">@{run.agent.profileKey}</span>
          </div>
        ) : null}
        <span className="text-meta min-w-0 flex-1 truncate text-muted-foreground">
          {operational.detail}
        </span>
        {run?.lastEventAt ? (
          <span className="text-meta shrink-0 text-muted-foreground">
            updated {relativeTime(run.lastEventAt)}
          </span>
        ) : null}
        {showTrace && run ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-meta inline-flex h-7 items-center gap-1 rounded px-1.5 text-muted-foreground hover:bg-subtle hover:text-foreground"
            aria-expanded={expanded}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
            Trace
          </button>
        ) : null}
      </div>
      {expanded && run ? (
        <div className="border-t border-border px-3 py-1">
          {events.isLoading ? (
            <div className="text-meta py-2 text-muted-foreground">Loading run trace…</div>
          ) : (
            <RunTimeline events={events.data ?? []} />
          )}
        </div>
      ) : null}
    </div>
  );
}
