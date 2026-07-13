"use client";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import { Bot, CircleAlert, ExternalLink, Inbox, Shield, Workflow } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { presenceAvailability } from "@/lib/transport-display";
import type { AppRouter } from "@/server/routers/_app";
import { canonicalIssueKey, summarizeQueue } from "./operations-model";

type QueueVariant = "panel" | "shelf";
type QueueIssue = inferRouterOutputs<AppRouter>["issue"]["queue"][number];

/**
 * Queue preview for Mission Control. The default panel variant remains useful
 * for narrow layouts; the shelf variant composes queue truth and agent health
 * into the selected desktop operations-console direction.
 */
export function QueueTab({
  slug,
  workspaceKey,
  variant = "panel",
}: {
  slug: string;
  workspaceKey: string;
  variant?: QueueVariant;
}) {
  const {
    data: queue,
    isLoading,
    isError,
  } = trpc.issue.queue.useQuery({
    includeClaimed: false,
    limit: 30,
  });

  if (isLoading) {
    return <div className="text-meta px-3 py-4 text-muted-foreground">Loading queue…</div>;
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-[0.75rem] text-danger">
        <CircleAlert className="h-4 w-4" /> Queue unavailable. Try again shortly.
      </div>
    );
  }

  const items = queue ?? [];
  const summary = summarizeQueue(items);

  if (variant === "shelf") {
    return <QueueShelf slug={slug} workspaceKey={workspaceKey} items={items} summary={summary} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {items.length === 0 && <QueueEmpty />}
        {items.length > 0 && (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              <StatCard label="In queue" value={`${summary.total}`} />
              <StatCard
                label="Unassigned"
                value={`${summary.unassigned}`}
                accent={summary.unassigned > 0 ? "warning" : undefined}
              />
              <StatCard
                label="Blocked"
                value={`${summary.blocked}`}
                accent={summary.blocked > 0 ? "danger" : undefined}
              />
            </div>
            <SectionLabel>Waiting for an agent</SectionLabel>
          </>
        )}
        {items.map((issue) => (
          <QueueRow key={issue.id} slug={slug} workspaceKey={workspaceKey} issue={issue} />
        ))}
      </div>
      <QueueFooter slug={slug} summary={summary} />
    </div>
  );
}

function QueueShelf({
  slug,
  workspaceKey,
  items,
  summary,
}: {
  slug: string;
  workspaceKey: string;
  items: QueueIssue[];
  summary: ReturnType<typeof summarizeQueue>;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-y-auto md:grid-cols-[13rem_minmax(0,1fr)_18rem] md:overflow-hidden">
      <aside
        className="border-b border-border/70 p-3 md:border-b-0 md:border-r"
        aria-label="Queue summary"
      >
        <SectionLabel>Summary</SectionLabel>
        <div className="mt-2 grid grid-cols-3 divide-x divide-border rounded-md border border-border bg-background/35">
          <SummaryMetric label="Queued" value={summary.total} />
          <SummaryMetric label="Unassigned" value={summary.unassigned} accent />
          <SummaryMetric label="Blocked" value={summary.blocked} danger={summary.blocked > 0} />
        </div>
        <div className="mt-3 hidden space-y-2 md:block">
          <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Dispatch state
          </div>
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {summary.unassigned > 0
              ? `${summary.unassigned} ${summary.unassigned === 1 ? "issue needs" : "issues need"} an agent.`
              : "Everything in the queue has an owner."}
          </p>
          <Link
            href={`/w/${slug}/issues`}
            className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-[0.6875rem] font-medium text-foreground hover:border-ember/40"
          >
            Open full queue <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </aside>

      <section
        className="flex min-h-[16rem] flex-col border-b border-border/70 md:min-h-0 md:border-b-0 md:border-r"
        aria-labelledby="mission-control-triage-heading"
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div>
            <div
              id="mission-control-triage-heading"
              className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Triage queue ({summary.total})
            </div>
            <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">
              Oldest unassigned work first
            </div>
          </div>
          <Link
            href={`/w/${slug}/issues`}
            className="text-[0.6875rem] text-ember hover:text-ember/80 md:hidden"
          >
            View all
          </Link>
        </div>
        <div className="min-h-0 flex-1 divide-y divide-border/70 overflow-y-auto border-y border-border/70 bg-background/25">
          {items.length === 0 && <QueueEmpty compact />}
          {items.map((issue) => (
            <QueueRow
              key={issue.id}
              slug={slug}
              workspaceKey={workspaceKey}
              issue={issue}
              compact
            />
          ))}
        </div>
        <div className="hidden items-center gap-2 px-3 py-1.5 text-[0.625rem] text-muted-foreground md:flex">
          <span>Use 1–4 to switch views</span>
          <span aria-hidden>·</span>
          <span>Esc collapses</span>
        </div>
      </section>

      <AgentPresenceShelf slug={slug} />
    </div>
  );
}

function AgentPresenceShelf({ slug }: { slug: string }) {
  const {
    data: agents,
    isLoading,
    isError,
  } = trpc.agent.list.useQuery({
    includeArchived: false,
  });

  const sorted = [...(agents ?? [])].sort((a, b) => {
    const rank = (status: string) => (status === "ONLINE" ? 0 : status === "BUSY" ? 1 : 2);
    return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name);
  });

  return (
    <aside className="p-3" aria-labelledby="mission-control-agent-presence-heading">
      <div
        id="mission-control-agent-presence-heading"
        className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        Agent presence
      </div>
      {isLoading && <div className="text-meta mt-3 text-muted-foreground">Loading agents…</div>}
      {isError && (
        <div className="mt-3 flex items-center gap-2 text-[0.6875rem] text-danger">
          <CircleAlert className="h-3.5 w-3.5" /> Agent status unavailable.
        </div>
      )}
      {!isLoading && !isError && sorted.length === 0 && (
        <div className="text-meta mt-3 text-muted-foreground">No agents in this workspace.</div>
      )}
      <div className="mt-2 space-y-1.5">
        {sorted.slice(0, 3).map((agent) => {
          const availability = presenceAvailability(agent);
          const onDemand = availability === "on-demand";
          const isOnline = agent.status === "ONLINE" || agent.status === "BUSY";
          const statusLabel = onDemand
            ? "Ready on demand"
            : isOnline
              ? agent.status === "BUSY"
                ? "Busy"
                : "Online"
              : agent.lastHeartbeatAt
                ? `Offline · ${relativeTime(agent.lastHeartbeatAt)}`
                : "Not connected";
          return (
            <Link
              key={agent.id}
              href={`/w/${slug}/agents/${agent.profileKey}`}
              className="focus-ring flex min-h-14 items-center gap-2 rounded-md border border-border bg-background/30 px-2.5 py-2 hover:border-ember/40"
            >
              <span
                className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  onDemand
                    ? "bg-sky-500"
                    : agent.status === "ONLINE"
                      ? "bg-success"
                      : agent.status === "BUSY"
                        ? "bg-ember"
                        : "bg-danger",
                )}
                aria-hidden
              />
              <Bot className="h-4 w-4 shrink-0 text-ember" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[0.75rem] font-medium text-foreground">
                    {agent.name}
                  </span>
                  <span className="truncate font-mono text-[0.625rem] text-muted-foreground">
                    @{agent.profileKey}
                  </span>
                </span>
                <span className="mt-0.5 block text-[0.625rem] text-muted-foreground">
                  {statusLabel}
                </span>
              </span>
              <span className="text-[0.625rem] text-ember">View</span>
            </Link>
          );
        })}
      </div>
      {sorted.length > 0 && (
        <Link
          href={`/w/${slug}/agents`}
          className="mt-2 inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
        >
          Open agents ({sorted.length}) <ExternalLink className="h-3 w-3" />
        </Link>
      )}
    </aside>
  );
}

function QueueEmpty({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1 text-center",
        compact ? "px-4 py-6" : "px-4 py-8",
      )}
    >
      <Inbox className="h-5 w-5 text-muted-foreground/50" />
      <div className="text-meta text-foreground/80">Queue is empty.</div>
      <div className="text-meta text-muted-foreground">
        Queued, unassigned issues land here for dispatch.
      </div>
    </div>
  );
}

function QueueFooter({
  slug,
  summary,
}: {
  slug: string;
  summary: ReturnType<typeof summarizeQueue>;
}) {
  return (
    <div className="text-meta flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
      <span className="text-muted-foreground">
        {summary.unassigned} unassigned
        {summary.blocked > 0 && <span className="text-warning"> · {summary.blocked} blocked</span>}
      </span>
      <Link
        href={`/w/${slug}/issues`}
        className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] font-medium text-foreground/80 hover:border-ember/40 hover:text-foreground sm:min-h-0"
      >
        Open issues <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pt-1 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  accent = false,
  danger = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="px-2 py-2 text-center">
      <div
        className={cn(
          "font-mono text-lg tabular-nums",
          danger ? "text-danger" : accent ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[0.5625rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "warning" | "danger";
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card/40 px-2 py-1.5">
      <div className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-mono text-base tabular-nums leading-none",
          accent === "warning"
            ? "text-warning"
            : accent === "danger"
              ? "text-danger"
              : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function QueueRow({
  slug,
  workspaceKey,
  issue,
  compact = false,
}: {
  slug: string;
  workspaceKey: string;
  issue: QueueIssue;
  compact?: boolean;
}) {
  const issueKey = canonicalIssueKey(workspaceKey, issue.number);
  return (
    <div
      className={cn(
        "text-[0.75rem]",
        compact ? "px-3 py-2" : "rounded-md border border-border bg-card/40 px-2.5 py-1.5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {issue.unblocked === false && (
          <Shield className="h-3 w-3 shrink-0 text-warning" aria-label="Blocked" />
        )}
        <Link
          href={`/w/${slug}/issues/${issue.id}`}
          className="shrink-0 font-mono text-[0.6875rem] text-foreground/80 hover:text-ember"
        >
          {issueKey}
        </Link>
        <span className="min-w-0 flex-1 truncate text-foreground" title={issue.title}>
          {issue.title}
        </span>
        <span className="hidden shrink-0 items-center gap-1 text-[0.625rem] text-muted-foreground sm:flex">
          <Workflow className="h-2.5 w-2.5" />
          {issue.assignedAgent
            ? `@${issue.assignedAgent.profileKey}`
            : issue.unblocked === false
              ? "Blocked"
              : "Unassigned"}
        </span>
        <Link
          href={`/w/${slug}/issues/${issue.id}`}
          className="focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-subtle hover:text-foreground md:h-7 md:w-7"
          aria-label={`Open ${issueKey}`}
          title="Open issue"
        >
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function relativeTime(input: Date | string): string {
  const ms = Math.max(0, Date.now() - new Date(input).getTime());
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
