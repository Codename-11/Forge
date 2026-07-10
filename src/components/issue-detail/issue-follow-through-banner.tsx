"use client";

import Link from "next/link";
import { AlertTriangle, ChevronRight, Clock3, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

type FollowThroughStatusCategory =
  | "BACKLOG"
  | "TODO"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "DONE"
  | "CANCELED"
  | string;

type FollowThroughAgent = {
  id: string;
  name: string;
  profileKey: string;
};

type FollowThroughRun = {
  id: string;
  status: string;
  engagementMode: string;
  summary?: string | null;
  currentStep?: string | null;
  agent?: { id: string; name?: string | null; profileKey?: string | null } | null;
};

export type IssueFollowThroughInput = {
  issueLabel: string;
  statusName: string;
  statusCategory: FollowThroughStatusCategory;
  updatedAt: Date | string;
  snoozedUntil?: Date | string | null;
  assignmentSlaMinutes: number;
  assignedAgent: FollowThroughAgent | null;
  latestRun: FollowThroughRun | null;
  hasActiveRun: boolean;
  now?: Date;
};

export type IssueFollowThroughModel = {
  title: string;
  description: string;
  evidence: string | null;
};

const FAILED_RUN_STATUSES = new Set(["STALLED", "ABANDONED", "ERROR", "ERRORED", "FAILED"]);

/**
 * Explain the issue-level gap that run-only banners cannot: an agent can
 * complete a valid Research/Review/Discuss turn while the issue remains in
 * Todo. Once that unchanged assignment crosses the workspace SLA, Forge is
 * waiting for an operator choice—not for a mysteriously active agent.
 */
export function getIssueFollowThroughModel(
  input: IssueFollowThroughInput,
): IssueFollowThroughModel | null {
  const now = input.now ?? new Date();
  if (
    !input.assignedAgent ||
    input.hasActiveRun ||
    input.assignmentSlaMinutes <= 0 ||
    !["BACKLOG", "TODO"].includes(input.statusCategory)
  ) {
    return null;
  }
  if (input.snoozedUntil && new Date(input.snoozedUntil).getTime() > now.getTime()) return null;

  const staleAt = new Date(input.updatedAt).getTime() + input.assignmentSlaMinutes * 60_000;
  if (!Number.isFinite(staleAt) || staleAt >= now.getTime()) return null;

  const latestRun = input.latestRun?.agent?.id === input.assignedAgent.id ? input.latestRun : null;
  if (latestRun && FAILED_RUN_STATUSES.has(latestRun.status.toUpperCase())) return null;

  const agentName = input.assignedAgent.name;
  const evidence = compactEvidence(latestRun?.summary ?? latestRun?.currentStep ?? null);

  if (latestRun?.status.toUpperCase() === "COMPLETED") {
    const mode = titleCase(latestRun.engagementMode);
    if (latestRun.engagementMode.toUpperCase() !== "EXECUTE") {
      return {
        title: `${mode} finished — choose what happens next`,
        description: `${agentName} completed a ${mode} run, but ${input.issueLabel} is still ${input.statusName} with no active run. Forge is waiting for an operator choice before work continues.`,
        evidence,
      };
    }
    return {
      title: `${input.issueLabel} still needs a status decision`,
      description: `${agentName} completed an Execute run, but the issue is still ${input.statusName}. Confirm the result, move the issue, or run it again.`,
      evidence,
    };
  }

  return {
    title: `${input.issueLabel} is assigned but not running`,
    description: `${agentName} is still assigned, no run is active, and the issue has not moved within the ${formatMinutes(input.assignmentSlaMinutes)} assignment window.`,
    evidence,
  };
}

export function IssueFollowThroughBanner({
  issueId,
  activityHref,
  input,
}: {
  issueId: string;
  activityHref: string;
  input: IssueFollowThroughInput;
}) {
  const utils = trpc.useUtils();
  const model = getIssueFollowThroughModel(input);
  const refresh = () => {
    void utils.issue.byId.invalidate({ id: issueId });
    void utils.issue.activity.invalidate({ issueId });
    void utils.event.timeline.invalidate();
    void utils.commandCenter.summary.invalidate();
  };
  const execute = trpc.issue.update.useMutation({
    onSuccess: () => {
      refresh();
      toast.success(`Started Execute with ${input.assignedAgent?.name ?? "assigned agent"}`);
    },
    onError: (error) => toast.error(error.message),
  });
  const snooze = trpc.issue.snooze.useMutation({
    onSuccess: () => {
      refresh();
      toast.success("Reminder snoozed for one day");
    },
    onError: (error) => toast.error(error.message),
  });

  if (!model || !input.assignedAgent) return null;
  const pending = execute.isPending || snooze.isPending;

  return (
    <section className="mb-3 rounded-md border border-warning/30 bg-warning/5 p-3 shadow-sm">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{model.title}</div>
          <p className="text-meta mt-0.5 leading-relaxed text-muted-foreground">
            {model.description}
          </p>
          {model.evidence ? (
            <p className="text-meta mt-2 line-clamp-3 rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-foreground/80">
              <span className="font-medium text-muted-foreground">Latest result: </span>
              {model.evidence}
            </p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ember"
              size="sm"
              disabled={pending}
              title="Starts a new Execute run with the assigned agent. Tool access still comes from that agent's runtime."
              onClick={() =>
                execute.mutate({
                  id: issueId,
                  assignedAgentId: input.assignedAgent!.id,
                  mode: "EXECUTE",
                })
              }
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              Run in Execute
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                snooze.mutate({
                  id: issueId,
                  until: new Date(Date.now() + 24 * 60 * 60_000),
                })
              }
            >
              <Clock3 className="h-3.5 w-3.5" aria-hidden />
              Snooze 1 day
            </Button>
            <Link
              href={activityHref}
              className="focus-ring inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-subtle hover:text-foreground"
            >
              Review activity
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>
          <p className="text-meta mt-2 text-muted-foreground">
            Execute changes the work contract, not the agent&apos;s repository or terminal access.
          </p>
        </div>
      </div>
    </section>
  );
}

function compactEvidence(value: string | null): string | null {
  if (!value) return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 320 ? `${clean.slice(0, 319)}…` : clean;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
