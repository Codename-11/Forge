"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Inbox,
  Clock,
  MessageCircle,
  Target,
  ChevronRight,
  Zap,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Card } from "@/components/settings/card";
import { Section } from "@/components/settings/section";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Unified "what's next" landing — the primary workspace home.
 *
 * Stack (top → bottom):
 *   1. Today's focus — one-line prompt with the count of unblocked,
 *      assigned issues in the current cycle.
 *   2. Workspace pulse — compact stat strip (open / in progress / done
 *      this week / active cycle).
 *   3. Assigned & unblocked list.
 *   4. Mentions list.
 *   5. Stalled > 7d list.
 *   6. Current cycle burn (single-workspace only).
 *
 * The cross-workspace toggle in the topbar aggregates items 3-5 across
 * every workspace the caller belongs to. Items 1-2 and 6 stay scoped to
 * the current workspace even in "all workspaces" mode — workspace-level
 * rollups across tenants don't mean anything useful.
 */
export default function InboxPage() {
  const workspace = useWorkspace();
  const [allWorkspaces, setAllWorkspaces] = useState(false);

  const { data, isLoading } = trpc.inbox.get.useQuery({ allWorkspaces });
  // Pulse numbers come from the standard issue list + status list —
  // cheaper than adding a dedicated router for numbers we already have.
  const { data: active } = trpc.issue.list.useQuery({
    includeDone: false,
    limit: 200,
  });
  const { data: recentDone } = trpc.issue.list.useQuery({
    includeDone: true,
    limit: 200,
  });

  const pulse = useMemo(() => {
    const openCount = active?.items.length ?? 0;
    const inProgress =
      active?.items.filter((i) => i.status.category === "IN_PROGRESS")
        .length ?? 0;
    const weekAgo = Date.now() - 7 * 86_400_000;
    const doneThisWeek =
      recentDone?.items.filter(
        (i) =>
          i.status.category === "DONE" &&
          new Date(i.updatedAt).getTime() >= weekAgo,
      ).length ?? 0;
    const activeCycle = data?.cycle?.name ?? "None";
    return { openCount, inProgress, doneThisWeek, activeCycle };
  }, [active, recentDone, data?.cycle]);

  const focusInCycle = useMemo(() => {
    if (!data) return 0;
    // Only count "in cycle" when we have a cycle to compare against.
    // Without one, fall back to the total unblocked count.
    if (!data.cycle) return data.counts.assignedUnblocked;
    const cycleIssueIds = new Set<string>();
    // `data.cycle` doesn't include its own issue list, so we approximate:
    // any assigned+unblocked item with a `cycleId` equal to `data.cycle.id`.
    // This is a best-effort count — server-side we could return this
    // directly; keeping the page logic on the client for now avoids a
    // router round-trip for a tiny number.
    for (const i of data.assignedUnblocked) {
      // `i` has no explicit cycle in the payload; fall back to counting all.
      cycleIssueIds.add(i.id);
    }
    return cycleIssueIds.size;
  }, [data]);

  return (
    <>
      <Topbar
        title="Inbox"
        subtitle="Everything worth looking at, in one place."
        actions={
          <div className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setAllWorkspaces(false)}
              className={cn(
                "focus-ring rounded px-2 py-1 transition-colors",
                !allWorkspaces
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              This workspace
            </button>
            <button
              type="button"
              onClick={() => setAllWorkspaces(true)}
              className={cn(
                "focus-ring rounded px-2 py-1 transition-colors",
                allWorkspaces
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              All my workspaces
            </button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 p-5">
          {/* Rollups — always render so the page doesn't jump while loading. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FocusRollup
              count={data ? focusInCycle : null}
              cycleName={data?.cycle?.name ?? null}
              slug={workspace.slug}
            />
            <PulseRollup
              openCount={pulse.openCount}
              inProgress={pulse.inProgress}
              doneThisWeek={pulse.doneThisWeek}
              activeCycle={pulse.activeCycle}
              slug={workspace.slug}
            />
          </div>

          {isLoading || !data ? (
            <p className="p-6 text-xs text-muted-foreground">Loading inbox…</p>
          ) : (
            <>
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    Assigned & unblocked
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {data.counts.assignedUnblocked}
                    </span>
                  </span>
                }
                hint="Your assignments that aren't waiting on anything else."
              >
                <Card>
                  {data.assignedUnblocked.length === 0 ? (
                    <EmptyState
                      icon={Inbox}
                      title="Nothing in your queue."
                      hint="Pick up something from Issues or press ⇧C to create one."
                    />
                  ) : (
                    data.assignedUnblocked.map((i) => (
                      <IssueRow
                        key={i.id}
                        issue={{
                          id: i.id,
                          number: i.number,
                          title: i.title,
                          workspace: i.workspace,
                          status: { name: i.status.name, color: i.status.color },
                          updatedAt: i.updatedAt,
                        }}
                      />
                    ))
                  )}
                </Card>
              </Section>

              <Section
                title={
                  <span className="flex items-center gap-2">
                    <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    Mentions
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {data.counts.mentions}
                    </span>
                  </span>
                }
                hint="Comments that @mention you in the last 7 days (schema placeholder — user.lastInboxVisitAt not yet persisted)."
              >
                <Card>
                  {data.mentions.length === 0 ? (
                    <EmptyState
                      icon={MessageCircle}
                      title="No recent mentions."
                    />
                  ) : (
                    data.mentions.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-start gap-3 px-3 py-2 text-[12px]"
                      >
                        <WorkspaceBadge
                          slug={m.issue.workspace.slug}
                          wsKey={m.issue.workspace.key}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/w/${m.issue.workspace.slug}/issues/${m.issue.id}`}
                              className="font-mono text-[11px] hover:underline"
                            >
                              {formatIssueId(m.issue.workspace.key, m.issue.number)}
                            </Link>
                            <span className="truncate">{m.issue.title}</span>
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {m.author.name ?? "Someone"}
                            </span>
                            {" — "}
                            {m.body}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {relativeTime(m.createdAt)}
                        </span>
                      </li>
                    ))
                  )}
                </Card>
              </Section>

              <Section
                title={
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                    Stalled &gt; 7d
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {data.counts.stalled}
                    </span>
                  </span>
                }
                hint="Your assignments without activity for more than a week."
              >
                <Card>
                  {data.stalled.length === 0 ? (
                    <EmptyState
                      icon={AlertTriangle}
                      title="Nothing stalled."
                      hint="Work is moving. Nice."
                    />
                  ) : (
                    data.stalled.map((i) => (
                      <IssueRow
                        key={i.id}
                        issue={{
                          id: i.id,
                          number: i.number,
                          title: i.title,
                          workspace: i.workspace,
                          status: { name: i.status.name, color: i.status.color },
                          updatedAt: i.updatedAt,
                        }}
                        tone="warn"
                      />
                    ))
                  )}
                </Card>
              </Section>

              {!allWorkspaces && (
                <Section
                  title={
                    <span className="flex items-center gap-2">
                      <Target className="h-3.5 w-3.5 text-muted-foreground" />
                      Current cycle burn
                    </span>
                  }
                  hint="Progress on the active cycle in this workspace."
                >
                  {data.cycle ? (
                    <div className="rounded-lg border border-border bg-card/40 p-4">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/w/${workspace.slug}/cycles/${data.cycle.id}`}
                            className="truncate text-sm font-semibold hover:underline"
                          >
                            {data.cycle.name}
                          </Link>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {data.cycle.done}/{data.cycle.total} done · {data.cycle.remaining} remaining
                          </div>
                        </div>
                        <div className="text-right font-mono text-2xl tabular-nums">
                          {data.cycle.pctDone}%
                        </div>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-subtle">
                        <div
                          className="h-full bg-ember transition-[width]"
                          style={{ width: `${data.cycle.pctDone}%` }}
                        />
                      </div>
                      <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>
                          {data.cycle.endsAt
                            ? `Ends ${relativeTime(data.cycle.endsAt)}`
                            : "No end date"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <Card as="div">
                      <EmptyState
                        icon={Target}
                        title="No active cycle."
                        hint="Start one from the Cycles page."
                      />
                    </Card>
                  )}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rollup blocks
// ---------------------------------------------------------------------------

function FocusRollup({
  count,
  cycleName,
  slug,
}: {
  count: number | null;
  cycleName: string | null;
  slug: string;
}) {
  const hasData = count !== null;
  return (
    <div className="group relative flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-card/40 p-4 transition-colors hover:border-ember/40">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ember/10 text-ember">
        <Zap className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Today&apos;s focus
        </div>
        <div className="mt-0.5 text-sm">
          {hasData ? (
            count === 0 ? (
              <span className="text-muted-foreground">
                Nothing pressing — pick something up, or press ⇧C.
              </span>
            ) : (
              <>
                <span className="font-mono tabular-nums">{count}</span>{" "}
                unblocked{" "}
                {count === 1 ? "issue" : "issues"} waiting on you
                {cycleName && (
                  <>
                    {" "}· cycle{" "}
                    <span className="font-medium">{cycleName}</span>
                  </>
                )}
                .
              </>
            )
          ) : (
            <span className="text-muted-foreground">Loading…</span>
          )}
        </div>
      </div>
      <Link
        href={`/w/${slug}/issues?mine=1`}
        className="ml-auto shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        title="Open my issues"
      >
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function PulseRollup({
  openCount,
  inProgress,
  doneThisWeek,
  activeCycle,
  slug,
}: {
  openCount: number;
  inProgress: number;
  doneThisWeek: number;
  activeCycle: string;
  slug: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Workspace pulse
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
        <Stat label="Open" value={openCount} href={`/w/${slug}/issues`} />
        <Stat
          label="In progress"
          value={inProgress}
          href={`/w/${slug}/issues`}
        />
        <Stat
          label="Done / 7d"
          value={doneThisWeek}
          href={`/w/${slug}/issues?status=done`}
        />
        <Stat
          label="Cycle"
          value={activeCycle}
          href={`/w/${slug}/cycles`}
          mono={false}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  mono = true,
}: {
  label: string;
  value: string | number;
  href?: string;
  mono?: boolean;
}) {
  const body = (
    <div className="flex min-w-0 flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "mt-0.5 truncate text-foreground",
          mono ? "font-mono text-sm tabular-nums" : "text-sm",
        )}
      >
        {value}
      </span>
    </div>
  );
  if (!href) return body;
  return (
    <Link
      href={href}
      className="min-w-0 rounded-md px-1 py-0.5 hover:bg-subtle/60"
    >
      {body}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Item rows
// ---------------------------------------------------------------------------

function IssueRow({
  issue,
  tone,
}: {
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { slug: string; key: string };
    status: { name: string; color: string };
    updatedAt: Date | string;
  };
  tone?: "warn";
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-subtle/40">
      <WorkspaceBadge slug={issue.workspace.slug} wsKey={issue.workspace.key} />
      <Link
        href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {formatIssueId(issue.workspace.key, issue.number)}
        </span>
        <span className="truncate">{issue.title}</span>
      </Link>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{
          backgroundColor: `${issue.status.color}22`,
          color: issue.status.color,
        }}
      >
        {issue.status.name}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[10px]",
          tone === "warn" ? "text-danger" : "text-muted-foreground",
        )}
      >
        {relativeTime(issue.updatedAt)}
      </span>
    </li>
  );
}

function WorkspaceBadge({ slug, wsKey }: { slug: string; wsKey: string }) {
  const c = workspaceColor(wsKey);
  return (
    <Link
      href={`/w/${slug}/inbox`}
      className="grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[9px] font-semibold"
      style={{
        backgroundColor: c.bg,
        color: c.fg,
        boxShadow: `inset 0 0 0 1px ${c.ring}`,
      }}
      title={wsKey}
    >
      {wsKey.slice(0, 2)}
    </Link>
  );
}
