"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bell,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { STALE_RUN_MS } from "@/lib/agent-stale";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

type AttentionRunStatus = "ACTIVE" | "WAITING" | "COMPLETED" | "ABANDONED" | "STALLED" | string;

export type OrchestrationAttentionRun = {
  id: string;
  status: AttentionRunStatus;
  summary?: string | null;
  currentStep?: string | null;
  startedAt?: string | Date | null;
  lastEventAt?: string | Date | null;
  acknowledgedAt?: string | Date | null;
  outputStartedAt?: string | Date | null;
  lastWakeAt?: string | Date | null;
  wakeAttempts?: number | null;
  finishedAt?: string | Date | null;
  awaitingApprovalAt?: string | Date | null;
  pendingApproval?: unknown;
  externalRunId?: string | null;
  controlState?: string | null;
  engagementMode?: "EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS" | string | null;
  clearedAt?: string | Date | null;
  agentId?: string | null;
  issueId?: string | null;
  agent?: {
    id: string;
    name: string;
    profileKey: string;
    avatar?: string | null;
    status?: string | null;
    runtimeId?: string | null;
  } | null;
  issue?: {
    id: string;
    number: number;
    title: string;
    assignedAgentId?: string | null;
    workspace?: { key: string; slug: string } | null;
  } | null;
};

export type OrchestrationAttentionStep = {
  id: string;
  title: string;
  status: string;
  issue?: OrchestrationAttentionRun["issue"] | null;
};

export function RunAttentionPanel({
  run,
  step,
  workspaceSlug,
  workspaceKey,
  className,
  onChanged,
}: {
  run: OrchestrationAttentionRun;
  step: OrchestrationAttentionStep;
  workspaceSlug: string;
  workspaceKey: string;
  className?: string;
  onChanged?: () => void;
}) {
  const utils = trpc.useUtils();
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [nudgeText, setNudgeText] = useState("please resume with the latest context");

  const retryStep = trpc.executionPlan.retryStep.useMutation({
    onSuccess: () => {
      toast.success("Step retry started");
      onChanged?.();
      void utils.agentRun.activeAll.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const kick = trpc.agentRun.kick.useMutation({
    onSuccess: (res) => {
      onChanged?.();
      if (res.kicked) {
        toast.success("Run kicked");
      } else {
        toast.message("Run is still fresh", {
          description: "Kick becomes available after the run is quiet for a few minutes.",
        });
      }
    },
    onError: (err) => toast.error(err.message),
  });
  const nudge = trpc.agentRun.nudge.useMutation({
    onSuccess: () => {
      setNudgeOpen(false);
      toast.success("Nudge sent");
      onChanged?.();
    },
    onError: (err) => toast.error(err.message),
  });
  const abandon = trpc.agentRun.abandon.useMutation({
    onSuccess: () => {
      toast.success("Run stopped");
      onChanged?.();
    },
    onError: (err) => toast.error(err.message),
  });
  const clear = trpc.agentRun.clearMany.useMutation({
    onSuccess: () => {
      toast.success("Run cleared");
      onChanged?.();
    },
    onError: (err) => toast.error(err.message),
  });
  const approval = trpc.agentRun.respondApproval.useMutation({
    onSuccess: (res) => {
      toast.success(res.decision === "approve" ? "Approval sent" : "Run rejected");
      onChanged?.();
    },
    onError: (err) => toast.error(err.message),
  });

  const issue = run.issue ?? step.issue ?? null;
  const agent = run.agent;
  const idleMs = run.lastEventAt ? Date.now() - new Date(run.lastEventAt).getTime() : 0;
  const isActive = run.status === "ACTIVE";
  const isWaiting = run.status === "WAITING";
  const isTerminalFailure = run.status === "STALLED" || run.status === "ABANDONED";
  const isStaleActive = isActive && idleMs >= STALE_RUN_MS;
  const canRetryStep = Boolean(
    isTerminalFailure || (isActive && isStaleActive) || isWaiting || run.awaitingApprovalAt,
  );
  const authHint = useMemo(
    () => looksCredentialRelated(run.summary) || looksCredentialRelated(run.currentStep),
    [run.summary, run.currentStep],
  );
  const approvalText = describeApproval(run.pendingApproval);
  const busy =
    retryStep.isPending ||
    kick.isPending ||
    nudge.isPending ||
    abandon.isPending ||
    clear.isPending ||
    approval.isPending;

  return (
    <div className={cn("rounded-lg border border-warning/35 bg-warning/[0.06] p-3", className)}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{titleForRun(run.status)}</span>
            <span className="rounded bg-card/60 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase text-muted-foreground">
              {run.status.toLowerCase()}
            </span>
            {run.clearedAt ? (
              <span className="rounded bg-card/60 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                cleared from queue
              </span>
            ) : null}
          </div>

          <div className="text-meta mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <span className="truncate">
              Step {step.status.toLowerCase()} · {step.title}
            </span>
            {agent ? (
              <>
                <span>·</span>
                <span className="text-id font-mono">@{agent.profileKey}</span>
              </>
            ) : null}
            {run.lastEventAt ? (
              <>
                <span>·</span>
                <span>last event {relativeTime(run.lastEventAt)}</span>
              </>
            ) : null}
          </div>

          {run.summary ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{run.summary}</p>
          ) : run.currentStep ? (
            <p className="mt-2 text-sm text-foreground/90">{run.currentStep}</p>
          ) : null}

          {run.awaitingApprovalAt ? (
            <div className="text-meta mt-2 rounded-md border border-ember/30 bg-ember/10 p-2">
              <div className="font-medium text-foreground">Runtime approval needed</div>
              <div className="mt-0.5 text-muted-foreground">
                {approvalText ??
                  "The runtime paused until an operator approves or rejects the request."}
              </div>
            </div>
          ) : null}

          {authHint ? (
            <div className="text-meta mt-2 flex items-start gap-1.5 rounded-md border border-warning/30 bg-card/40 p-2">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <div>
                <div className="font-medium text-foreground">
                  Credential attention likely needed
                </div>
                <div className="text-muted-foreground">
                  Reconnect the runtime/profile, then retry this step so the new run stays attached
                  to the plan.
                </div>
              </div>
            </div>
          ) : null}

          {nudgeOpen ? (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-card/40 p-2 sm:flex-row">
              <input
                autoFocus
                value={nudgeText}
                onChange={(e) => setNudgeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nudgeText.trim()) {
                    nudge.mutate({ runId: run.id, message: nudgeText.trim() });
                  }
                  if (e.key === "Escape") setNudgeOpen(false);
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
              <Button
                size="sm"
                variant="ember"
                disabled={busy || !nudgeText.trim()}
                onClick={() => nudge.mutate({ runId: run.id, message: nudgeText.trim() })}
              >
                <Bell className="h-3.5 w-3.5" />
                Send
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setNudgeOpen(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {run.awaitingApprovalAt ? (
                <>
                  <Button
                    size="sm"
                    variant="ember"
                    disabled={busy}
                    onClick={() =>
                      approval.mutate({ runId: run.id, decision: "approve", scope: "session" })
                    }
                  >
                    {approval.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Approve session
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      approval.mutate({ runId: run.id, decision: "approve", scope: "once" })
                    }
                  >
                    Approve once
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-warning"
                    disabled={busy}
                    onClick={() => approval.mutate({ runId: run.id, decision: "reject" })}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                </>
              ) : null}

              {canRetryStep ? (
                <Button
                  size="sm"
                  variant="ember"
                  disabled={busy}
                  onClick={() => retryStep.mutate({ stepId: step.id })}
                  title="Open a new run tied to this plan step"
                >
                  {retryStep.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Retry step
                </Button>
              ) : null}

              {isActive ? (
                <Button
                  size="sm"
                  variant={isStaleActive ? "outline" : "ghost"}
                  disabled={busy}
                  onClick={() => kick.mutate({ runId: run.id })}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Kick
                </Button>
              ) : null}

              {isActive || isWaiting ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setNudgeOpen(true)}
                >
                  <Bell className="h-3.5 w-3.5" />
                  Nudge
                </Button>
              ) : null}

              {isActive || isWaiting ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-warning"
                  disabled={busy}
                  onClick={() =>
                    abandon.mutate({
                      runId: run.id,
                      alsoUnassign: false,
                      summary: "Stopped by operator from the plan cockpit.",
                    })
                  }
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop
                </Button>
              ) : null}

              {isTerminalFailure && !run.clearedAt ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => clear.mutate({ runIds: [run.id] })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear
                </Button>
              ) : null}

              {issue ? (
                <Link
                  href={`/w/${issue.workspace?.slug ?? workspaceSlug}/issues/${issue.id}`}
                  className="focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition hover:bg-subtle hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open {issue.workspace?.key ?? workspaceKey}-{issue.number}
                </Link>
              ) : null}

              {agent?.runtimeId ? (
                <Link
                  href={`/w/${workspaceSlug}/settings/runtimes/${agent.runtimeId}`}
                  className="focus-ring inline-flex h-7 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition hover:bg-subtle hover:text-foreground"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  Runtime
                </Link>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function pickAttentionRun<
  TStep extends {
    id: string;
    title: string;
    status: string;
    runs?: OrchestrationAttentionRun[] | null;
    issue?:
      | (NonNullable<OrchestrationAttentionRun["issue"]> & {
          agentRuns?: OrchestrationAttentionRun[] | null;
        })
      | null;
  },
>(steps: TStep[]): { step: TStep; run: OrchestrationAttentionRun } | null {
  const candidates: Array<{
    step: TStep;
    run: OrchestrationAttentionRun;
    rank: number;
    ts: number;
  }> = [];
  for (const step of steps) {
    const runs = [...(step.runs ?? []), ...(step.issue?.agentRuns ?? [])];
    for (const run of runs) {
      candidates.push({
        step,
        run,
        rank: attentionRank(run),
        ts: run.lastEventAt ? new Date(run.lastEventAt).getTime() : 0,
      });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || b.ts - a.ts);
  const best = candidates[0];
  if (!best || best.rank >= 90) return null;
  return { step: best.step, run: best.run };
}

function attentionRank(run: OrchestrationAttentionRun): number {
  if (run.awaitingApprovalAt) return 0;
  if (run.status === "WAITING") return 1;
  if (run.status === "STALLED") return 2;
  if (run.status === "ABANDONED" && !run.clearedAt) return 3;
  if (run.status === "ACTIVE") {
    const last = run.lastEventAt ? new Date(run.lastEventAt).getTime() : Date.now();
    return Date.now() - last >= STALE_RUN_MS ? 4 : 90;
  }
  return 99;
}

function titleForRun(status: AttentionRunStatus): string {
  if (status === "WAITING") return "Waiting on operator";
  if (status === "STALLED") return "Run stalled";
  if (status === "ABANDONED") return "Run stopped before completion";
  if (status === "ACTIVE") return "Run needs attention";
  return "Run attention needed";
}

function looksCredentialRelated(value?: string | null): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  return (
    text.includes("refresh token") ||
    text.includes("access token") ||
    text.includes("credential") ||
    text.includes("sign in") ||
    text.includes("log out") ||
    text.includes("unauthorized") ||
    text.includes("authentication")
  );
}

function describeApproval(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["description", "command", "title", "reason"]) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}
