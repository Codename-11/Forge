"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleDot,
  GitPullRequestArrow,
  MessageCircle,
  Shield,
  Target,
  User,
  Workflow,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { useRealtime } from "@/hooks/use-realtime";
import { cn, relativeTime } from "@/lib/utils";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type TimelineRow = RouterOutputs["event"]["timeline"]["items"][number];
type TimelineFilter = "all" | "mine" | "agents" | "decisions";

const FILTERS: Array<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "agents", label: "Agents" },
  { id: "decisions", label: "Decisions" },
];

const REALTIME_KINDS = [
  "ISSUE_CREATED",
  "ISSUE_UPDATED",
  "ISSUE_STATUS_CHANGED",
  "ISSUE_ASSIGNED",
  "ISSUE_PRIORITY_CHANGED",
  "ISSUE_QUEUED",
  "COMMENT_CREATED",
  "AGENT_ASSIGNED",
  "AGENT_NOACK",
  "AGENT_STATUS_CHANGED",
  "AGENT_RUN_STARTED",
  "AGENT_RUN_BLOCKED",
  "AGENT_RUN_COMPLETED",
  "AGENT_RUN_STALLED",
  "AGENT_RUN_CLEARED",
  "AGENT_RUN_CONTROL_REQUESTED",
  "AGENT_RUN_KICKED",
  "GOAL_CREATED",
  "GOAL_STATUS_CHANGED",
  "EXECUTION_STEP_READY",
  "EXECUTION_STEP_JUDGED",
  "PLAN_BUDGET_EXCEEDED",
] as const;

export function WorkspaceActivityTimeline({
  limit = 8,
  defaultFilter = "all",
  showFilters = true,
  className,
}: {
  limit?: number;
  defaultFilter?: TimelineFilter;
  showFilters?: boolean;
  className?: string;
}) {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<TimelineFilter>(defaultFilter);
  const query = trpc.event.timeline.useQuery(
    { limit, filter },
    { staleTime: 30_000, refetchOnWindowFocus: true },
  );

  useRealtime(
    () => {
      void utils.event.timeline.invalidate();
      void utils.event.agentAttention.invalidate();
    },
    { kind: [...REALTIME_KINDS] },
  );

  const items = query.data?.items ?? [];

  return (
    <section className={cn("rounded-lg border border-border bg-card/40", className)}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">Workspace activity</span>
        <span className="text-meta text-muted-foreground">
          {filter === "all"
            ? "Recent changes"
            : filter === "mine"
              ? "Your trail"
              : filter === "agents"
                ? "Agent work"
                : "Needs attention"}
        </span>
        {showFilters ? (
          <div className="ml-auto flex shrink-0 rounded-md border border-border bg-background p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={cn(
                  "focus-ring rounded px-1.5 py-0.5 text-[0.6875rem]",
                  filter === f.id
                    ? "bg-ember/10 text-ember"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {query.isLoading ? (
        <div className="p-4">
          <SkeletonList rows={4} />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          variant="card"
          icon={<Activity />}
          title="No recent activity"
          description="Workspace changes will appear here."
        />
      ) : (
        <ol className="divide-y divide-border">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityRow({ item }: { item: TimelineRow }) {
  const Icon = iconFor(item);
  return (
    <li>
      <Link
        href={item.href}
        className="group flex min-w-0 gap-3 px-4 py-2.5 hover:bg-subtle/40"
      >
        <span
          className={cn(
            "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border",
            toneClass(item.tone),
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {item.title}
          </span>
          {item.detail ? (
            <span className="mt-0.5 block line-clamp-2 text-meta text-muted-foreground">
              {item.detail}
            </span>
          ) : null}
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            {item.actor.kind === "agent" ? (
              <Bot className="h-3 w-3 text-ember" />
            ) : item.actor.kind === "user" ? (
              <User className="h-3 w-3" />
            ) : (
              <CircleDot className="h-3 w-3" />
            )}
            <span className={cn("truncate", item.actor.kind === "agent" && "text-id")}>
              {item.actor.label}
            </span>
            <span aria-hidden>·</span>
            <span className="capitalize">{item.category}</span>
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-meta tabular-nums text-muted-foreground">
          {relativeTime(item.createdAt)}
        </span>
      </Link>
    </li>
  );
}

function iconFor(item: TimelineRow) {
  if (item.tone === "danger") return AlertTriangle;
  if (item.tone === "warning") return Shield;
  if (item.tone === "success") return CheckCircle2;
  switch (item.category) {
    case "agent":
    case "run":
      return Bot;
    case "goal":
      return Target;
    case "plan":
      return Workflow;
    case "decision":
      return Shield;
    case "chat":
      return MessageCircle;
    case "issue":
      return GitPullRequestArrow;
    default:
      return Activity;
  }
}

function toneClass(tone: TimelineRow["tone"]): string {
  switch (tone) {
    case "danger":
      return "border-danger/30 bg-danger/10 text-danger";
    case "warning":
      return "border-warning/30 bg-warning/10 text-warning";
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "muted":
      return "border-border bg-subtle text-muted-foreground";
    default:
      return "border-border bg-background text-muted-foreground";
  }
}
