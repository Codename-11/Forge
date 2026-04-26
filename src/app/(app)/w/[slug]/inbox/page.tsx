"use client";
import type { AgentStatus } from "@prisma/client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Inbox,
  Clock,
  MessageCircle,
  Sun,
  Target,
  ChevronRight,
  Zap,
  Bot,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge, Card, EmptyState, Kbd, MOTION, Section, SkeletonList } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Unified "what's next" landing — the primary workspace home.
 *
 * Stack (top → bottom):
 *   1. Today's focus — one-line prompt with the count of unblocked,
 *      assigned issues in the current sprint.
 *   2. Workspace pulse — compact stat strip (open / in progress / done
 *      this week / active sprint).
 *   3. Assigned & unblocked list.
 *   4. Mentions list.
 *   5. Stalled > 7d list.
 *   6. Current sprint burn (single-workspace only).
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
  const { data: agentQueue, isLoading: queueLoading } = trpc.issue.queue.useQuery(
    { includeClaimed: true, limit: 25 },
    { enabled: !allWorkspaces },
  );
  const { data: agents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: !allWorkspaces },
  );
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
    const inProgress = active?.items.filter((i) => i.status.category === "IN_PROGRESS").length ?? 0;
    const weekAgo = Date.now() - 7 * 86_400_000;
    const doneThisWeek =
      recentDone?.items.filter(
        (i) => i.status.category === "DONE" && new Date(i.updatedAt).getTime() >= weekAgo,
      ).length ?? 0;
    const activeSprint = data?.cycle?.name ?? "None";
    return { openCount, inProgress, doneThisWeek, activeSprint };
  }, [active, recentDone, data?.cycle]);

  const focusInCycle = useMemo(() => {
    if (!data) return 0;
    // Only count "in sprint" when we have a cycle row to compare against.
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

  const queueRows = !allWorkspaces ? (agentQueue ?? []) : [];
  const readyAgentIssues = queueRows.filter((i) => i.unblocked && !i.claimedAt).length;
  const claimedAgentIssues = queueRows.filter((i) => !!i.claimedAt).length;
  const assignedAgentIssues = queueRows.filter((i) => !!i.assignedAgent).length;
  const onlineAgents =
    agents?.filter((a) => a.status === "ONLINE" || a.status === "BUSY").length ?? 0;

  return (
    <>
      <Topbar
        title="Inbox"
        subtitle="Everything worth looking at, in one place."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-[0.6875rem]">
              <button
                type="button"
                onClick={() => setAllWorkspaces(false)}
                className={cn(
                  "focus-ring rounded px-2 py-1",
                  MOTION.fast,
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
                  "focus-ring rounded px-2 py-1",
                  MOTION.fast,
                  allWorkspaces
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                All my workspaces
              </button>
            </div>
            <Link
              href={`/w/${workspace.slug}/dashboard`}
              className="focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground"
              title="Workspace overview — onboarding, focus, recent done"
            >
              Workspace overview
              <ChevronRight className="h-3 w-3" />
            </Link>
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
              activeSprint={pulse.activeSprint}
              slug={workspace.slug}
            />
          </div>

          {!allWorkspaces && (
            <AgentQueueSection
              rows={queueRows}
              loading={queueLoading}
              workspaceKey={workspace.key}
              slug={workspace.slug}
              ready={readyAgentIssues}
              claimed={claimedAgentIssues}
              assigned={assignedAgentIssues}
              onlineAgents={onlineAgents}
            />
          )}

          {isLoading || !data ? (
            <div className="space-y-4">
              <SkeletonList rows={4} />
              <SkeletonList rows={3} />
            </div>
          ) : data.assignedUnblocked.length === 0 &&
            data.mentions.length === 0 &&
            data.stalled.length === 0 ? (
            <div className="rounded-lg border border-border bg-card/30 px-6 py-16">
              <EmptyState
                variant="page"
                icon={<Sun />}
                title="Inbox zero"
                description="When someone @mentions you, assigns work, or replies to a thread you're following, it lands here."
              />
            </div>
          ) : (
            <>
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    Assigned & unblocked
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      {data.counts.assignedUnblocked}
                    </span>
                  </span>
                }
                hint="Your assignments that aren't waiting on anything else."
              >
                <Card as="ul">
                  {data.assignedUnblocked.length === 0 ? (
                    <EmptyState
                      as="li"
                      variant="card"
                      icon={<Inbox />}
                      title="Nothing in your queue."
                      description={
                        <span>
                          Pick up something from Issues or press <Kbd>⇧C</Kbd> to create one.
                        </span>
                      }
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
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      {data.counts.mentions}
                    </span>
                  </span>
                }
                hint="Comments that @mention you in the last 7 days (schema placeholder — user.lastInboxVisitAt not yet persisted)."
              >
                <Card as="ul">
                  {data.mentions.length === 0 ? (
                    <EmptyState
                      as="li"
                      variant="card"
                      icon={<MessageCircle />}
                      title="No recent mentions."
                      description="Comments that @mention you land here."
                    />
                  ) : (
                    data.mentions.map((m) => (
                      <li key={m.id} className="flex items-start gap-3 px-3 py-2 text-[0.75rem]">
                        <WorkspaceBadge
                          slug={m.issue.workspace.slug}
                          wsKey={m.issue.workspace.key}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/w/${m.issue.workspace.slug}/issues/${m.issue.id}`}
                              className="font-mono text-[0.6875rem] hover:underline"
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
                        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
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
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      {data.counts.stalled}
                    </span>
                  </span>
                }
                hint="Your assignments without activity for more than a week."
              >
                <Card as="ul">
                  {data.stalled.length === 0 ? (
                    <EmptyState
                      as="li"
                      variant="card"
                      icon={<AlertTriangle />}
                      title="Nothing stalled."
                      description="Work is moving. Nice."
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
                      Current sprint burn
                    </span>
                  }
                  hint="Progress on the active sprint in this workspace."
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
                          <div className="font-mono text-[0.6875rem] text-muted-foreground">
                            {data.cycle.done}/{data.cycle.total} done · {data.cycle.remaining}{" "}
                            remaining
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
                      <div className="mt-3 flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span>
                          {data.cycle.endsAt
                            ? `Ends ${relativeTime(data.cycle.endsAt)}`
                            : "No end date"}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <Card>
                      <EmptyState
                        variant="section"
                        icon={<Target />}
                        title="No active sprint."
                        description="Start one from the Sprints page."
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
    <div
      className={cn(
        "group relative flex items-center gap-3 overflow-hidden rounded-lg border border-border bg-card/40 p-4 hover:border-ember/40",
        MOTION.base,
      )}
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ember/10 text-ember">
        <Zap className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
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
                <span className="font-mono tabular-nums">{count}</span> unblocked{" "}
                {count === 1 ? "issue" : "issues"} waiting on you
                {cycleName && (
                  <>
                    {" "}
                    · sprint <span className="font-medium">{cycleName}</span>
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
        className={cn(
          "ml-auto shrink-0 text-muted-foreground group-hover:text-foreground",
          MOTION.fast,
        )}
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
  activeSprint,
  slug,
}: {
  openCount: number;
  inProgress: number;
  doneThisWeek: number;
  activeSprint: string;
  slug: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-4">
      <div className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
        Workspace pulse
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 text-[0.6875rem]">
        <Stat label="Open" value={openCount} href={`/w/${slug}/issues`} />
        <Stat label="In progress" value={inProgress} href={`/w/${slug}/issues`} />
        <Stat label="Done / 7d" value={doneThisWeek} href={`/w/${slug}/issues?status=done`} />
        <Stat label="Sprint" value={activeSprint} href={`/w/${slug}/cycles`} mono={false} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent queue
// ---------------------------------------------------------------------------

type AgentQueueIssue = {
  id: string;
  number: number;
  title: string;
  priority: string;
  claimedAt: Date | string | null;
  claimExpiresAt: Date | string | null;
  unblocked: boolean;
  status: { name: string; color: string };
  project: { key: string; color: string | null } | null;
  claimedBy: { name: string | null; email: string | null } | null;
  assignedAgent: {
    id: string;
    name: string;
    profileKey: string;
    status: AgentStatus;
  } | null;
};

function AgentQueueSection({
  rows,
  loading,
  workspaceKey,
  slug,
  ready,
  claimed,
  assigned,
  onlineAgents,
}: {
  rows: AgentQueueIssue[];
  loading: boolean;
  workspaceKey: string;
  slug: string;
  ready: number;
  claimed: number;
  assigned: number;
  onlineAgents: number;
}) {
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          Agent queue
          <span className="font-mono text-[0.6875rem] text-muted-foreground">{rows.length}</span>
        </span>
      }
      hint={`${ready} ready now · ${assigned} assigned · ${claimed} claimed · ${onlineAgents} online/busy agents`}
    >
      <Card as="ul">
        {loading ? (
          <li className="px-3 py-3">
            <SkeletonList rows={3} />
          </li>
        ) : rows.length === 0 ? (
          <EmptyState
            as="li"
            variant="card"
            icon={<Bot />}
            title="No queued agent work."
            description="Queue an issue from its detail page when it is ready for an agent to claim."
          />
        ) : (
          rows.map((issue) => (
            <li key={issue.id} className="px-3 py-2 hover:bg-subtle/40">
              <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
                <Link
                  href={`/w/${slug}/issues/${issue.id}`}
                  className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
                >
                  <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
                    {formatIssueId(workspaceKey, issue.number)}
                  </span>
                  <span className="truncate">{issue.title}</span>
                </Link>
                <Badge color={issue.status.color}>{issue.status.name}</Badge>
                {issue.project && (
                  <Badge color={issue.project.color ?? undefined}>{issue.project.key}</Badge>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted-foreground">
                <QueueStateBadge issue={issue} />
                {issue.assignedAgent ? (
                  <span
                    className="inline-flex items-center gap-1"
                    title={`Assigned to ${issue.assignedAgent.name}`}
                  >
                    <AgentPresenceDot status={issue.assignedAgent.status} size="sm" />
                    <span className="font-mono">@{issue.assignedAgent.profileKey}</span>
                  </span>
                ) : (
                  <span>unassigned</span>
                )}
                {issue.claimExpiresAt && (
                  <span>claim expires {relativeTime(issue.claimExpiresAt)}</span>
                )}
              </div>
            </li>
          ))
        )}
      </Card>
    </Section>
  );
}

function QueueStateBadge({ issue }: { issue: AgentQueueIssue }) {
  if (issue.claimedAt) {
    const by = issue.claimedBy?.name ?? issue.claimedBy?.email ?? "agent";
    return <Badge className="bg-ember/10 text-ember">Claimed by {by}</Badge>;
  }
  if (!issue.unblocked) {
    return <Badge className="bg-danger/10 text-danger">Blocked</Badge>;
  }
  return <Badge className="bg-success/10 text-success">Ready to claim</Badge>;
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
    <Link href={href} className="min-w-0 rounded-md px-1 py-0.5 hover:bg-subtle/60">
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
    <li className="flex items-center gap-3 px-3 py-2 text-[0.75rem] hover:bg-subtle/40">
      <WorkspaceBadge slug={issue.workspace.slug} wsKey={issue.workspace.key} />
      <Link
        href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 hover:underline"
      >
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
          {formatIssueId(issue.workspace.key, issue.number)}
        </span>
        <span className="truncate">{issue.title}</span>
      </Link>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6875rem]"
        style={{
          backgroundColor: `${issue.status.color}22`,
          color: issue.status.color,
        }}
      >
        {issue.status.name}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[0.6875rem]",
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
      className="grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[0.6875rem] font-semibold"
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
