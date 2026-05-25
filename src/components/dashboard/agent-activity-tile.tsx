"use client";
import Link from "next/link";
import { Bot, AlertTriangle, ChevronRight } from "lucide-react";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Per-agent at-a-glance health tile for the dashboard. Sits between
 * Today and Quick Notes. Renders one row per non-archived agent with:
 *
 *   - presence dot + name + @profileKey (mono)
 *   - load X/Y (Y = maxConcurrent, ∞ when 0)
 *   - stalled-run count chip (red, hidden when 0)
 *   - stalled-issue count chip (warning, hidden when 0)
 *   - last heartbeat
 *
 * Click the row → /agents/[profileKey].
 *
 * Sorted by stalled-run desc → stalled-issue desc → load desc → name
 * asc, server-side, so the worst-off agent is always on top.
 *
 * Hidden when no agents exist — the dashboard skips rendering it
 * entirely. Empty state is "No agents configured. → Settings" so the
 * tile gives the operator a path forward.
 */
export function AgentActivityTile({ slug }: { slug: string }) {
  const { data, isLoading } = trpc.dashboard.agentActivity.useQuery();

  if (isLoading || !data) {
    return (
      <section className="rounded-lg border border-border bg-card/40">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-medium">Agents</span>
        </header>
        <div className="space-y-2 p-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="h-9 animate-pulse rounded-md bg-subtle/50"
            />
          ))}
        </div>
      </section>
    );
  }

  if (data.agents.length === 0) {
    // No agents configured — render the empty-state directive instead
    // of nothing. The dashboard parent decides whether to mount this
    // when the operator hasn't onboarded any agents at all (it does);
    // this empty form gives them the next click.
    return null;
  }

  const stalledRunTotal = data.agents.reduce(
    (sum, a) => sum + a.stalledRuns,
    0,
  );
  const stalledIssueTotal = data.agents.reduce(
    (sum, a) => sum + a.stalledIssues,
    0,
  );

  return (
    <section className="rounded-lg border border-border bg-card/40">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">Agents</span>
        <span className="text-meta text-muted-foreground">
          {data.agents.length} active
          {stalledRunTotal > 0 && (
            <span className="ml-1.5 text-danger">
              · {stalledRunTotal} stalled run
              {stalledRunTotal === 1 ? "" : "s"}
            </span>
          )}
          {stalledIssueTotal > 0 && (
            <span className="ml-1.5 text-warning">
              · {stalledIssueTotal} stalled issue
              {stalledIssueTotal === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <Link
          href={`/w/${slug}/agents`}
          className="ml-auto text-[0.75rem] text-muted-foreground hover:text-foreground"
          title="Open the agents dashboard"
        >
          Open all →
        </Link>
      </header>
      <ul className="divide-y divide-border">
        {data.agents.map((a) => (
          <li key={a.id}>
            <Link
              href={`/w/${slug}/agents/${a.profileKey}`}
              className="group flex items-center gap-2 px-4 py-2 text-[0.75rem] hover:bg-subtle/40"
              title={`Open ${a.name}`}
            >
              <AgentPresenceDot status={a.status} availability={a.availability} size="sm" />
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-subtle text-[0.6875rem]">
                {a.avatar ?? a.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate font-medium text-foreground">
                  {a.name}
                </span>
                <span className="text-id text-muted-foreground">
                  @{a.profileKey}
                </span>
              </div>
              {a.stalledRuns > 0 && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-danger/10 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-danger"
                  title={`${a.stalledRuns} run${a.stalledRuns === 1 ? "" : "s"} stalled (5m+ idle)`}
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  {a.stalledRuns} stl
                </span>
              )}
              {a.stalledIssues > 0 && (
                <span
                  className="shrink-0 rounded-sm bg-warning/10 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-warning"
                  title={`${a.stalledIssues} issue${a.stalledIssues === 1 ? "" : "s"} quiet past threshold`}
                >
                  {a.stalledIssues} quiet
                </span>
              )}
              <span
                className={cn(
                  "shrink-0 font-mono text-id",
                  a.maxConcurrent > 0 && a.load >= a.maxConcurrent
                    ? "text-warning"
                    : "text-muted-foreground",
                )}
                title="Active load / max concurrent"
              >
                {a.load}/{a.maxConcurrent === 0 ? "∞" : a.maxConcurrent}
              </span>
              <span
                className="shrink-0 text-meta text-muted-foreground"
                title={
                  a.lastHeartbeatAt
                    ? `Last heartbeat ${new Date(a.lastHeartbeatAt).toLocaleString()}`
                    : "Never heartbeated"
                }
              >
                {a.lastHeartbeatAt ? relativeTime(a.lastHeartbeatAt) : "—"}
              </span>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
