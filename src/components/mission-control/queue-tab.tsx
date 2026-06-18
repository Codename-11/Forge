"use client";
import Link from "next/link";
import { Bot, ExternalLink, Shield, Inbox, Workflow } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Queue tab. Quick-access preview of queued/unassigned issues.
 * Dispatching and queue management belong on the durable issue/ops
 * surfaces; this dock tab stays read-only and deep-links out.
 */

export function QueueTab({ slug }: { slug: string }) {
  const { data: queue, isLoading } = trpc.issue.queue.useQuery({
    includeClaimed: false,
    limit: 30,
  });

  if (isLoading) {
    return <div className="text-meta px-3 py-4 text-muted-foreground">Loading queue…</div>;
  }

  const items = queue ?? [];
  const unassignedCount = items.filter((q) => !q.assignedAgent).length;
  const blockedCount = items.filter((q) => q.unblocked === false).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {items.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <Inbox className="h-5 w-5 text-muted-foreground/50" />
            <div className="text-meta text-foreground/80">Queue is empty.</div>
            <div className="text-meta text-muted-foreground">
              Queued, unassigned issues land here for dispatch.
            </div>
          </div>
        )}
        {items.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-1.5 min-[400px]:grid-cols-3">
              <StatCard label="In queue" value={`${items.length}`} />
              <StatCard
                label="Unassigned"
                value={`${unassignedCount}`}
                accent={unassignedCount > 0 ? "warning" : undefined}
              />
              <StatCard
                label="Blocked"
                value={`${blockedCount}`}
                accent={blockedCount > 0 ? "danger" : undefined}
              />
            </div>
            <SectionLabel>Waiting for an agent</SectionLabel>
          </>
        )}
        {items.map((issue) => {
          const issueKey = `${(issue as unknown as { workspace?: { key: string } }).workspace?.key ?? slug.toUpperCase()}-${issue.number}`;
          return (
            <QueueRow
              key={issue.id}
              slug={slug}
              issue={{
                id: issue.id,
                number: issue.number,
                title: issue.title,
                key: issueKey,
                blocked: issue.unblocked === false,
                assignedAgent: issue.assignedAgent
                  ? {
                      id: issue.assignedAgent.id,
                      name: issue.assignedAgent.name,
                      profileKey: issue.assignedAgent.profileKey,
                    }
                  : null,
              }}
            />
          );
        })}
      </div>
      <div className="text-meta flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
        <span className="text-muted-foreground">
          {unassignedCount} unassigned
          {blockedCount > 0 && (
            <>
              {" "}
              · <span className="text-warning">{blockedCount} blocked</span>
            </>
          )}
        </span>
        <Link
          href={`/w/${slug}/issues`}
          className="focus-ring inline-flex min-h-9 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] font-medium text-foreground/80 hover:border-ember/40 hover:text-foreground sm:min-h-0"
        >
          Open issues
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
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

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "warning" | "danger" | "success";
}) {
  const valueTone =
    accent === "warning"
      ? "text-warning"
      : accent === "danger"
        ? "text-danger"
        : accent === "success"
          ? "text-success"
          : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-card/40 px-2 py-1.5">
      <div className="text-[0.5625rem] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-base tabular-nums leading-none", valueTone)}>{value}</div>
      {sub && <div className="text-meta text-muted-foreground">{sub}</div>}
    </div>
  );
}

function QueueRow({
  slug,
  issue,
}: {
  slug: string;
  issue: {
    id: string;
    number: number;
    title: string;
    key: string;
    blocked: boolean;
    assignedAgent: { id: string; name: string; profileKey: string } | null;
  };
}) {
  return (
    <div className="rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem]">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {issue.blocked && <Shield className="h-3 w-3 shrink-0 text-warning" aria-label="Blocked" />}
        <Link
          href={`/w/${slug}/issues/${issue.id}`}
          className="shrink-0 font-mono text-[0.6875rem] text-foreground/80 hover:text-ember"
        >
          {issue.key}
        </Link>
        <span className="min-w-[12rem] flex-1 truncate text-foreground" title={issue.title}>
          {issue.title}
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {issue.assignedAgent ? (
            <span
              className="flex min-h-8 items-center gap-1 rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.65625rem] text-ember sm:min-h-0"
              title={`Assigned to ${issue.assignedAgent.name}`}
            >
              <Bot className="h-3 w-3" />
              {issue.assignedAgent.profileKey}
            </span>
          ) : null}
          <Link
            href={`/w/${slug}/issues/${issue.id}`}
            className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground sm:h-5 sm:w-5"
            aria-label="Open issue"
            title="Open issue"
          >
            <ExternalLink className="h-3 w-3" />
          </Link>
        </span>
      </div>
      {/* Dispatch-state hint — mirrors the design's reason line without
          inventing a matcher verdict the queue payload doesn't carry. */}
      <div className="mt-1 flex items-center gap-1 pl-0.5 text-[0.625rem]">
        <Workflow className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
        {issue.assignedAgent ? (
          <span className="font-mono text-ember">→ @{issue.assignedAgent.profileKey}</span>
        ) : issue.blocked ? (
          <span className="text-warning">blocked · waiting on dependencies</span>
        ) : (
          <span className="text-muted-foreground">waiting for an agent</span>
        )}
      </div>
    </div>
  );
}
