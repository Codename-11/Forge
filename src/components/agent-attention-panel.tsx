"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { EmptyState, SkeletonList } from "@/components/ui";
import { ExpandableText } from "@/components/ui/expandable-text";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { useRealtime } from "@/hooks/use-realtime";
import { cn, relativeTime } from "@/lib/utils";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type AgentAttentionRow = RouterOutputs["event"]["agentAttention"]["agents"][number];
type AgentAttentionItem = AgentAttentionRow["items"][number];

const REALTIME_KINDS = [
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
  "EXECUTION_STEP_READY",
  "EXECUTION_STEP_JUDGED",
  "PLAN_BUDGET_EXCEEDED",
] as const;

export function AgentAttentionPanel({
  slug,
  limit = 5,
  itemLimit = 3,
  showEmpty = false,
  excludeRunIds = [],
  className,
  bodyClassName,
}: {
  slug: string;
  limit?: number;
  itemLimit?: number;
  showEmpty?: boolean;
  /** Suppress detail rows already represented by a canonical recovery card
   * elsewhere on the same page. Aggregate agent counts remain visible. */
  excludeRunIds?: string[];
  className?: string;
  bodyClassName?: string;
}) {
  const utils = trpc.useUtils();
  const query = trpc.event.agentAttention.useQuery(
    { limit, itemLimit },
    { staleTime: 30_000, refetchOnWindowFocus: true },
  );

  useRealtime(
    () => {
      void utils.event.agentAttention.invalidate();
      void utils.commandCenter.summary.invalidate();
    },
    { kind: [...REALTIME_KINDS] },
  );

  const excludedItems = new Set(excludeRunIds.flatMap((id) => [`blocker:${id}`, `run:${id}`]));
  const rows = (query.data?.agents ?? []).map((row) => ({
    ...row,
    items: row.items.filter((item) => !excludedItems.has(item.id)),
  }));
  if (!showEmpty && !query.isLoading && rows.length === 0) return null;

  return (
    <section className={cn("rounded-lg border border-border bg-card/40", className)}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">Agent attention</span>
        <span className="text-meta text-muted-foreground">
          {rows.length > 0 ? `${rows.length} with activity` : "All clear"}
        </span>
        <Link
          href={`/w/${slug}/agents`}
          className="focus-ring text-meta ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
        >
          Agents
          <ChevronRight className="h-3 w-3" />
        </Link>
      </header>
      <div className={cn("min-h-0", bodyClassName)}>
        {query.isLoading ? (
          <div className="p-4">
            <SkeletonList rows={4} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            variant="card"
            icon={<CheckCircle2 />}
            title="No agent attention needed"
            description="Questions, approvals, blocked runs, and active turns appear here."
          />
        ) : (
          <div className="divide-y divide-border">
            {rows.map((row) => (
              <AgentAttentionCard key={row.agent.id} row={row} slug={slug} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AgentAttentionCard({ row, slug }: { row: AgentAttentionRow; slug: string }) {
  const agentHref = `/w/${slug}/agents/${row.agent.profileKey}`;
  return (
    <div className="p-3">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
        <AgentPresenceDot
          status={row.agent.status}
          availability={row.agent.availability}
          size="sm"
        />
        <Link href={agentHref} className="min-w-0 flex-1 hover:underline">
          <span className="truncate text-sm font-medium">{row.agent.name}</span>{" "}
          <span className="text-id text-muted-foreground">@{row.agent.profileKey}</span>
        </Link>
        <AttentionCount label="blocked" value={row.counts.blocked} tone="danger" />
        <AttentionCount label="asks" value={row.counts.questions} tone="warning" />
        <AttentionCount label="approvals" value={row.counts.approvals} tone="warning" />
        <AttentionCount label="active" value={row.counts.activeRuns} tone="neutral" />
      </div>
      <ul className="space-y-1.5">
        {row.items.map((item) => (
          <li key={item.id}>
            <div className="group flex min-w-0 items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 hover:border-ember/40">
              <span
                className={cn(
                  "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full",
                  itemToneClass(item.tone),
                )}
              >
                <ItemIcon item={item} />
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  href={item.href}
                  className="block truncate text-[0.75rem] font-medium hover:underline"
                >
                  {item.title}
                </Link>
                <ExpandableText content={item.detail} className="text-meta text-muted-foreground" />
              </div>
              <span className="text-meta shrink-0 pt-0.5 tabular-nums text-muted-foreground">
                {relativeTime(item.createdAt)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AttentionCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "danger" | "warning" | "neutral";
}) {
  if (value === 0) return null;
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.625rem] uppercase",
        tone === "danger"
          ? "bg-danger/10 text-danger"
          : tone === "warning"
            ? "bg-warning/10 text-warning"
            : "bg-subtle text-muted-foreground",
      )}
    >
      {value} {label}
    </span>
  );
}

function ItemIcon({ item }: { item: AgentAttentionItem }) {
  switch (item.kind) {
    case "question":
      return <CircleHelp className="h-3 w-3" />;
    case "review":
      return <ShieldCheck className="h-3 w-3" />;
    case "blocked":
      return <AlertTriangle className="h-3 w-3" />;
    case "approval":
      return <Clock3 className="h-3 w-3" />;
    case "active":
      return <Workflow className="h-3 w-3" />;
  }
}

function itemToneClass(tone: AgentAttentionItem["tone"]): string {
  switch (tone) {
    case "danger":
      return "bg-danger/10 text-danger";
    case "warning":
      return "bg-warning/10 text-warning";
    case "success":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    default:
      return "bg-subtle text-muted-foreground";
  }
}
