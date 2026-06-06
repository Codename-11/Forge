"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import {
  RefreshCw,
  AlertTriangle,
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Eraser,
  Loader2,
  ShieldCheck,
  StopCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

/**
 * Admin-only Control Plane tab. Shows:
 *  1. Webhook delivery queue with status filter + retry.
 *  2. Queue depth summary (PENDING deliveries grouped by webhook URL / agent).
 *  3. Recent dispatches (SUCCESS, last 20).
 */

type FilterStatus = "all" | "PENDING" | "FAILED" | "DEAD_LETTER";
type RecoveryItem = inferRouterOutputs<AppRouter>["agentRun"]["recovery"]["items"][number];
type RecoveryAction = RecoveryItem["recommendedAction"];

function relativeTime(input: Date | string | null | undefined): string {
  if (!input) return "—";
  const t = typeof input === "string" ? new Date(input) : input;
  const ms = Date.now() - t.getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "SUCCESS"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : status === "PENDING"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : status === "FAILED"
          ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
          : "border-red-700/30 bg-red-700/10 text-red-800 dark:text-red-300";
  return (
    <span
      className={cn(
        "rounded border px-1 py-0 font-mono text-[0.5625rem] uppercase tracking-wider",
        cls,
      )}
    >
      {status === "DEAD_LETTER" ? "dead" : status.toLowerCase()}
    </span>
  );
}

function ControlStatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "warning" | "danger";
}) {
  const valueTone =
    accent === "warning"
      ? "text-amber-600"
      : accent === "danger"
        ? "text-red-600"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card/40 px-2 py-1.5">
      <div className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("font-mono text-base leading-none tabular-nums", valueTone)}>
        {value}
      </div>
    </div>
  );
}

function recoveryActionCopy(action: RecoveryAction): {
  label: string;
  title: string;
  icon: typeof Eraser;
} {
  if (action === "ABANDON") {
    return {
      label: "Abandon",
      title: "Abandon this stale run and clear it from operational queues",
      icon: StopCircle,
    };
  }
  if (action === "RECONCILE") {
    return {
      label: "Reconcile",
      title: "Mark this protocol-failed completion reviewed without rewriting history",
      icon: ShieldCheck,
    };
  }
  return {
    label: "Clear",
    title: "Clear this terminal failure from operational queues",
    icon: Eraser,
  };
}

function RunRecoveryRow({
  item,
  slug,
  pending,
  onRecover,
}: {
  item: RecoveryItem;
  slug: string;
  pending: boolean;
  onRecover: (action: RecoveryAction, runId: string) => void;
}) {
  const issue = item.run.issue;
  const issueKey = `${issue.workspace.key}-${issue.number}`;
  const action = recoveryActionCopy(item.recommendedAction);
  const ActionIcon = action.icon;
  const tone =
    item.severity === "error"
      ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
      : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return (
    <div className="rounded-md border border-border bg-card/40 px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Bot className="h-3.5 w-3.5 shrink-0 text-ember" />
        <span className="font-medium text-foreground">{item.run.agent.name}</span>
        <span className="font-mono text-[0.65625rem] text-muted-foreground">
          @{item.run.agent.profileKey}
        </span>
        <Link
          href={`/w/${slug}/issues/${issue.id}`}
          className="font-mono text-[0.65625rem] text-foreground/80 hover:text-ember"
        >
          {issueKey}
        </Link>
        <span
          className={cn(
            "rounded border px-1 py-0 font-mono text-[0.5625rem] uppercase tracking-wider",
            tone,
          )}
          title={item.detail}
        >
          {item.reason.replace("-", " ")}
        </span>
        <span className="ml-auto text-meta text-muted-foreground">
          {relativeTime(item.run.finishedAt ?? item.run.lastEventAt)}
        </span>
      </div>
      <div className="mt-1 text-meta text-muted-foreground">
        <span className="font-medium text-foreground/80">{item.title}</span>
        {" · "}
        {item.detail}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {item.diagnostics.slice(0, 2).map((diagnostic) => (
          <span
            key={diagnostic.code}
            className="rounded border border-border bg-background/50 px-1.5 py-0.5 font-mono text-[0.5625rem] uppercase tracking-wider text-muted-foreground"
            title={diagnostic.description}
          >
            {diagnostic.title}
          </span>
        ))}
        <button
          type="button"
          disabled={pending}
          onClick={() => onRecover(item.recommendedAction, item.id)}
          title={action.title}
          className="ml-auto inline-flex min-h-8 items-center gap-1 rounded border border-border px-2 py-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground hover:border-ember/40 hover:text-foreground disabled:opacity-50 sm:min-h-0"
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ActionIcon className="h-3 w-3" />}
          {action.label}
        </button>
      </div>
    </div>
  );
}

function RunRecoverySection({
  slug,
}: {
  slug: string;
}) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.agentRun.recovery.useQuery(
    { limit: 50 },
    { staleTime: 5_000 },
  );
  const recover = trpc.agentRun.recoverMany.useMutation({
    onError: (e) => toast.error(e.message),
    onSuccess: (result) => {
      if (result.changed > 0) {
        const verb =
          result.action === "ABANDON"
            ? "abandoned"
            : result.action === "RECONCILE"
              ? "reconciled"
              : "cleared";
        toast.success(`${result.changed} run${result.changed === 1 ? "" : "s"} ${verb}.`);
      } else {
        toast.message("No recoverable runs changed.");
      }
    },
    onSettled: () => {
      void utils.agentRun.recovery.invalidate();
      void utils.agentRun.runtimeCompliance.invalidate();
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.recentTerminal.invalidate();
      void utils.commandCenter.summary.invalidate();
    },
  });
  const items = data?.items ?? [];
  const recoverable = (action: RecoveryAction) =>
    items.filter((item) => item.availableActions.includes(action));
  const bulk = (action: RecoveryAction) => {
    const runIds = recoverable(action).map((item) => item.id);
    if (runIds.length === 0) return;
    recover.mutate({ action, runIds });
  };

  return (
    <div className="border-b border-border/60 px-3 py-2">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Run Recovery
        </span>
        {data && (
          <span className="font-mono text-[0.625rem] text-muted-foreground">
            {data.counts.total} counted
          </span>
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {(["ABANDON", "RECONCILE", "CLEAR"] as RecoveryAction[]).map((action) => {
            const count = recoverable(action).length;
            if (count === 0) return null;
            const copy = recoveryActionCopy(action);
            const Icon = copy.icon;
            return (
              <button
                key={action}
                type="button"
                disabled={recover.isPending}
                onClick={() => bulk(action)}
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[0.5625rem] uppercase tracking-wider text-muted-foreground hover:border-ember/40 hover:text-foreground disabled:opacity-50"
                title={`${copy.label} ${count} run${count === 1 ? "" : "s"}`}
              >
                <Icon className="h-2.5 w-2.5" />
                {copy.label} {count}
              </button>
            );
          })}
        </span>
      </div>
      {data && (
        <div className="mb-2 grid grid-cols-4 gap-1.5">
          <ControlStatCard label="Stale" value={`${data.counts.activeStale}`} accent={data.counts.activeStale ? "warning" : undefined} />
          <ControlStatCard label="Terminal" value={`${data.counts.terminalFailures}`} accent={data.counts.terminalFailures ? "danger" : undefined} />
          <ControlStatCard label="Protocol" value={`${data.counts.protocolFailed}`} accent={data.counts.protocolFailed ? "danger" : undefined} />
          <ControlStatCard label="Scanned" value={`${data.scanned}`} />
        </div>
      )}
      {isLoading ? (
        <div className="py-3 text-meta text-muted-foreground">Loading run recovery…</div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-border/60 bg-card/30 px-2 py-2 text-meta text-muted-foreground">
          No stale, uncleared, or protocol-failed runs.
        </div>
      ) : (
        <div className="space-y-1">
          {items.map((item) => (
            <RunRecoveryRow
              key={item.id}
              item={item}
              slug={slug}
              pending={recover.isPending && recover.variables?.runIds.includes(item.id)}
              onRecover={(action, runId) => recover.mutate({ action, runIds: [runId] })}
            />
          ))}
        </div>
      )}
      {data?.truncated && (
        <div className="mt-1.5 text-meta text-muted-foreground">
          Showing the first {items.length} recovery rows from a bounded scan.
        </div>
      )}
    </div>
  );
}

type DeliveryItem = {
  id: string;
  status: string;
  attempt: number;
  scheduledAt: Date;
  deliveredAt?: Date | null;
  responseStatus?: number | null;
  responseBody?: string | null;
  webhook: { id: string; url: string; pluginId: string | null; events: string[] };
  event: {
    id: string;
    kind: string;
    subjectType: string;
    subjectId: string;
    createdAt: Date;
    payload: unknown;
  };
};

function DeliveryRow({
  item,
  onRetry,
  isRetrying,
}: {
  item: DeliveryItem;
  onRetry: (id: string) => void;
  isRetrying: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const canRetry = item.status === "FAILED" || item.status === "DEAD_LETTER";

  return (
    <div className="rounded-md border border-border bg-card/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-subtle/30"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <StatusPill status={item.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.65625rem] text-muted-foreground">
          {item.webhook.url.replace(/^https?:\/\//, "")}
        </span>
        <span className="shrink-0 text-id text-muted-foreground">{item.event.kind}</span>
        <span className="shrink-0 text-meta text-muted-foreground">
          #{item.attempt}
        </span>
        <span className="shrink-0 text-meta text-muted-foreground">
          {relativeTime(item.scheduledAt)}
        </span>
        {canRetry && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(item.id);
            }}
            disabled={isRetrying}
            className="ml-1 flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[0.5625rem] uppercase tracking-wider text-muted-foreground hover:border-ember/40 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className="h-2.5 w-2.5" />
            Retry
          </button>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border/60 px-3 py-2 space-y-1">
          <div className="flex items-baseline gap-2 text-meta">
            <span className="text-muted-foreground">URL</span>
            <span className="font-mono text-[0.65625rem] text-foreground/80 break-all">
              {item.webhook.url}
            </span>
          </div>
          <div className="flex items-baseline gap-2 text-meta">
            <span className="text-muted-foreground">Event</span>
            <span className="font-mono text-id text-foreground/80">{item.event.kind}</span>
            <span className="text-muted-foreground">{item.event.subjectType} / {item.event.subjectId}</span>
          </div>
          {item.responseStatus != null && (
            <div className="flex items-baseline gap-2 text-meta">
              <span className="text-muted-foreground">HTTP</span>
              <span
                className={cn(
                  "font-mono text-id",
                  item.responseStatus >= 200 && item.responseStatus < 300
                    ? "text-emerald-600"
                    : "text-red-600",
                )}
              >
                {item.responseStatus}
              </span>
            </div>
          )}
          {item.responseBody && (
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-subtle/60 px-2 py-1.5 font-mono text-[0.5625rem] text-muted-foreground">
              {item.responseBody}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ControlTab({ slug }: { slug: string }) {
  const ws = useMaybeWorkspace();
  const isAdmin = ws?.role === "OWNER" || ws?.role === "ADMIN";

  const [filter, setFilter] = useState<FilterStatus>("all");
  const utils = trpc.useUtils();

  // Gate the queries on admin role rather than the hook order so the
  // rules-of-hooks invariant holds while the admin-only API stays admin-only.
  const { data, isLoading } = trpc.admin.webhookDeliveries.list.useQuery(
    { status: filter === "all" ? undefined : filter, limit: 50 },
    { staleTime: 5_000, enabled: isAdmin },
  );

  const { data: pendingData } = trpc.admin.webhookDeliveries.list.useQuery(
    { status: "PENDING", limit: 200 },
    { staleTime: 5_000, enabled: isAdmin },
  );

  const { data: successData } = trpc.admin.webhookDeliveries.list.useQuery(
    { status: "SUCCESS", limit: 20 },
    { staleTime: 10_000, enabled: isAdmin },
  );

  const retryM = trpc.admin.webhookDeliveries.retry.useMutation({
    onSuccess: () => void utils.admin.webhookDeliveries.list.invalidate(),
  });

  if (!isAdmin) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[0.75rem] text-muted-foreground">
        Admin only.
      </div>
    );
  }

  const items = (data?.items ?? []) as DeliveryItem[];

  // Queue depth: PENDING deliveries grouped by webhook URL
  const pendingItems = (pendingData?.items ?? []) as DeliveryItem[];
  const pendingByUrl = new Map<string, number>();
  for (const item of pendingItems) {
    const url = item.webhook.url;
    pendingByUrl.set(url, (pendingByUrl.get(url) ?? 0) + 1);
  }
  const queueDepthEntries = [...pendingByUrl.entries()].sort((a, b) => b[1] - a[1]);

  const recentSuccess = (successData?.items ?? []) as DeliveryItem[];

  const FILTER_BUTTONS: { id: FilterStatus; label: string }[] = [
    { id: "all", label: "All" },
    { id: "PENDING", label: "Pending" },
    { id: "FAILED", label: "Failed" },
    { id: "DEAD_LETTER", label: "Dead" },
  ];

  // Health summary cards — derived from queries already in flight; no new
  // data wiring. "Dead" surfaces the DLQ the design's failure card calls out.
  const deadCount = items.filter((i) => i.status === "DEAD_LETTER").length;
  const failedCount = items.filter((i) => i.status === "FAILED").length;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* ---- Health summary ---- */}
      <div className="grid grid-cols-3 gap-1.5 border-b border-border/60 px-3 py-2">
        <ControlStatCard label="Pending" value={`${pendingItems.length}`} />
        <ControlStatCard
          label="Failed"
          value={`${failedCount}`}
          accent={failedCount > 0 ? "warning" : undefined}
        />
        <ControlStatCard
          label="Dead-letter"
          value={`${deadCount}`}
          accent={deadCount > 0 ? "danger" : undefined}
        />
      </div>

      <RunRecoverySection slug={slug} />

      {/* ---- Section 1: Webhook Deliveries ---- */}
      <div className="border-b border-border/60 px-3 py-2">
        <div className="mb-2 flex items-center gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Webhook Deliveries
          </span>
          <span className="ml-auto flex items-center gap-1">
            {FILTER_BUTTONS.map((btn) => (
              <button
                key={btn.id}
                type="button"
                onClick={() => setFilter(btn.id)}
                className={cn(
                  "rounded px-2 py-0.5 text-[0.625rem] uppercase tracking-wider",
                  filter === btn.id
                    ? "bg-subtle text-foreground"
                    : "text-muted-foreground hover:bg-subtle/50 hover:text-foreground",
                )}
              >
                {btn.label}
              </button>
            ))}
          </span>
        </div>

        {isLoading && (
          <div className="py-3 text-meta text-muted-foreground">Loading…</div>
        )}
        {!isLoading && items.length === 0 && (
          <div className="py-3 text-meta text-muted-foreground">No deliveries found.</div>
        )}
        <div className="space-y-1">
          {items.map((item) => (
            <DeliveryRow
              key={item.id}
              item={item}
              onRetry={(id) => retryM.mutate({ id })}
              isRetrying={retryM.isPending && retryM.variables?.id === item.id}
            />
          ))}
        </div>
      </div>

      {/* ---- Section 2: Queue Depth ---- */}
      <div className="border-b border-border/60 px-3 py-2">
        <div className="mb-2 flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Queue Depth
          </span>
          <span className="ml-1.5 font-mono text-[0.625rem] text-muted-foreground">
            {pendingItems.length} pending
          </span>
        </div>

        {queueDepthEntries.length === 0 ? (
          <div className="py-2 text-meta text-muted-foreground">Queue is empty.</div>
        ) : (
          <div className="space-y-0.5">
            {queueDepthEntries.map(([url, count]) => (
              <div
                key={url}
                className="flex items-center gap-2 rounded px-1.5 py-1"
              >
                <span
                  className={cn(
                    "flex h-4 min-w-[1.25rem] items-center justify-center rounded border font-mono text-[0.5625rem]",
                    count > 10
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-600"
                      : "border-border bg-subtle/40 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.65625rem] text-muted-foreground">
                  {url.replace(/^https?:\/\//, "")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Section 3: Recent Dispatches (SUCCESS) ---- */}
      <div className="px-3 py-2">
        <div className="mb-2 flex items-center gap-1.5">
          <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Dispatches
          </span>
        </div>

        {recentSuccess.length === 0 ? (
          <div className="py-2 text-meta text-muted-foreground">No successful deliveries yet.</div>
        ) : (
          <div className="space-y-1">
            {recentSuccess.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded px-1.5 py-1 text-meta"
              >
                <StatusPill status={item.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-[0.65625rem] text-muted-foreground">
                  {item.event.kind}
                </span>
                <span className="shrink-0 font-mono text-[0.65625rem] text-muted-foreground truncate max-w-[8rem]">
                  {item.webhook.url.replace(/^https?:\/\//, "").split("/")[0]}
                </span>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {relativeTime(item.deliveredAt ?? item.scheduledAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
