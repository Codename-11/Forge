"use client";
import { useState } from "react";
import { RefreshCw, AlertTriangle, Activity, ChevronDown, ChevronRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn } from "@/lib/utils";

/**
 * Admin-only Control Plane tab. Shows:
 *  1. Webhook delivery queue with status filter + retry.
 *  2. Queue depth summary (PENDING deliveries grouped by webhook URL / agent).
 *  3. Recent dispatches (SUCCESS, last 20).
 */

type FilterStatus = "all" | "PENDING" | "FAILED" | "DEAD_LETTER";

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

export function ControlTab({ slug: _slug }: { slug: string }) {
  const ws = useMaybeWorkspace();

  if (ws?.role !== "OWNER" && ws?.role !== "ADMIN") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-[0.75rem] text-muted-foreground">
        Admin only.
      </div>
    );
  }

  const [filter, setFilter] = useState<FilterStatus>("all");
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.admin.webhookDeliveries.list.useQuery(
    { status: filter === "all" ? undefined : filter, limit: 50 },
    { staleTime: 5_000 },
  );

  const { data: pendingData } = trpc.admin.webhookDeliveries.list.useQuery(
    { status: "PENDING", limit: 200 },
    { staleTime: 5_000 },
  );

  const { data: successData } = trpc.admin.webhookDeliveries.list.useQuery(
    { status: "SUCCESS", limit: 20 },
    { staleTime: 10_000 },
  );

  const retryM = trpc.admin.webhookDeliveries.retry.useMutation({
    onSuccess: () => void utils.admin.webhookDeliveries.list.invalidate(),
  });

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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
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
