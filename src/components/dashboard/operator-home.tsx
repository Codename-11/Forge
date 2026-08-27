"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  Inbox,
  Sparkles,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AgentActivityTile } from "@/components/dashboard/agent-activity-tile";
import { TodayWidget } from "@/components/dashboard/today-widget";
import type { DashboardWorkCard } from "@/components/dashboard/issue-card";
import { useWorkspace } from "@/hooks/use-workspace";
import { hasUnseenChangelog } from "@/lib/changelog";
import { formatDueDate } from "@/lib/issue-display";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { useTimePrefs } from "@/lib/time-prefs";

const DASHBOARD_LAYOUT_VERSION = 3;
const HEALTH_DRAWER_ID = "workspace-health";

const PRIORITY_GLYPH: Record<string, string> = {
  URGENT: "!!!",
  HIGH: "!!",
  MEDIUM: "!",
  LOW: "·",
  NONE: "—",
};

export type OperatorLanes = {
  recommended: DashboardWorkCard | null;
  now: DashboardWorkCard[];
  next: DashboardWorkCard[];
  waiting: DashboardWorkCard[];
};

function waitingOnOthers(card: DashboardWorkCard): boolean {
  return (
    card.latestRun?.status === "WAITING" ||
    card.latestRun?.status === "STALLED" ||
    card.status.category === "IN_REVIEW"
  );
}

function belongsNow(card: DashboardWorkCard, nowMs: number): boolean {
  const dueMs = card.dueDate ? new Date(card.dueDate).getTime() : Number.POSITIVE_INFINITY;
  return (
    card.status.category === "IN_PROGRESS" ||
    card.priority === "URGENT" ||
    card.priority === "HIGH" ||
    dueMs <= nowMs + 48 * 60 * 60 * 1000
  );
}

/** One deterministic pass: every card appears in at most one lane. */
export function buildOperatorLanes(
  focus: DashboardWorkCard[],
  resume: DashboardWorkCard[],
  nowMs = Date.now(),
): OperatorLanes {
  const seen = new Set<string>();
  const cards = [...focus, ...resume].filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });

  const waiting = cards.filter(waitingOnOthers);
  const available = cards.filter((card) => !waitingOnOthers(card));
  const urgent = available.filter((card) => belongsNow(card, nowMs));
  const ordinary = available.filter((card) => !belongsNow(card, nowMs));
  const now = (urgent.length > 0 ? urgent : ordinary).slice(0, 5);
  const nowIds = new Set(now.map((card) => card.id));
  const next = [...urgent, ...ordinary].filter((card) => !nowIds.has(card.id)).slice(0, 4);

  return {
    recommended: now[0] ?? next[0] ?? waiting[0] ?? null,
    now,
    next,
    waiting: waiting.slice(0, 3),
  };
}

export function OperatorHome() {
  const workspace = useWorkspace();
  const prefs = useTimePrefs();
  const { data: ws } = trpc.workspace.current.useQuery();
  const { data: me } = trpc.workspace.me.useQuery();
  const myWork = trpc.dashboard.myWork.useQuery();

  const lanes = useMemo(
    () => buildOperatorLanes(myWork.data?.focus ?? [], myWork.data?.resume ?? []),
    [myWork.data?.focus, myWork.data?.resume],
  );

  const firstName = (me?.user.name ?? me?.user.email ?? "").split(/[\s@]/)[0] || "there";
  const waitingCount = lanes.waiting.length;
  const activeCount = lanes.now.filter((card) => card.status.category === "IN_PROGRESS").length;

  return (
    <div className="space-y-4" data-testid="dashboard-operator-home">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-0.5 pb-3">
        <h1 className="text-sm font-semibold tracking-tight">Good day, {firstName}.</h1>
        <span className="hidden h-3 w-px bg-border sm:block" aria-hidden />
        <span className="text-meta text-muted-foreground">
          Focus today: {activeCount} in progress
          {waitingCount > 0 ? ` · ${waitingCount} waiting on others` : ""}
        </span>
      </header>

      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-12 xl:items-start">
        <main className="min-w-0 xl:col-span-8">
          <WorkLanes
            lanes={lanes}
            loading={myWork.isLoading}
            slug={workspace.slug}
            workspaceKey={ws?.key ?? "—"}
            timezone={prefs.timezone ?? null}
          />
        </main>

        <aside className="min-w-0 space-y-4 xl:col-span-4" aria-label="Live operations">
          <AttentionRail slug={workspace.slug} />
          <AgentActivityTile slug={workspace.slug} />
          <TodayWidget slug={workspace.slug} workspaceKey={ws?.key ?? "—"} maxDueSoon={4} />
        </aside>
      </div>

      <WorkspaceHealthDrawer slug={workspace.slug} />
    </div>
  );
}

function WorkLanes({
  lanes,
  loading,
  slug,
  workspaceKey,
  timezone,
}: {
  lanes: OperatorLanes;
  loading: boolean;
  slug: string;
  workspaceKey: string;
  timezone: string | null;
}) {
  if (loading) {
    return (
      <section aria-label="Loading work lanes" className="animate-pulse">
        <div className="mb-4 h-11 rounded-lg border border-border bg-card/30" />
        <div className="space-y-px border-y border-border/80">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex h-10 items-center gap-3 px-2">
              <span className="h-2 w-8 rounded bg-subtle" />
              <span className="h-2 w-14 rounded bg-subtle" />
              <span className="h-2 flex-1 rounded bg-subtle" />
              <span className="h-5 w-20 rounded bg-subtle" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const empty =
    !lanes.recommended && !lanes.now.length && !lanes.next.length && !lanes.waiting.length;
  if (empty) {
    return (
      <section className="rounded-lg border border-dashed border-border bg-card/20 p-8 text-center">
        <CheckCircle2 className="mx-auto h-5 w-5 text-success" />
        <h2 className="mt-3 text-sm font-semibold">Nothing needs you right now</h2>
        <p className="text-meta mt-1 text-muted-foreground">
          Open an issue or pick from Suggestions.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="dashboard-work-heading">
      <div className="mb-3 flex items-center gap-2">
        <h2
          id="dashboard-work-heading"
          className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          What needs me now?
        </h2>
      </div>

      {lanes.recommended && (
        <Link
          href={`/w/${slug}/issues/${lanes.recommended.id}`}
          className="focus-ring group mb-4 grid min-w-0 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-ember/50 bg-ember/5 px-4 py-3 hover:bg-ember/10 sm:grid-cols-[auto_auto_auto_minmax(0,1fr)_auto_auto]"
          data-testid="dashboard-recommended-next"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-ember" aria-hidden />
          <span className="shrink-0 text-xs font-semibold text-ember">Recommended next</span>
          <span className="text-id hidden shrink-0 text-muted-foreground sm:block">
            {formatIssueId(workspaceKey, lanes.recommended.number)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {lanes.recommended.title}
          </span>
          <Badge className="shrink-0" color={lanes.recommended.status.color}>
            {lanes.recommended.status.name}
          </Badge>
          <ArrowRight className="hidden h-3.5 w-3.5 shrink-0 text-ember transition-transform group-hover:translate-x-0.5 sm:block" />
        </Link>
      )}

      <div className="relative pl-8">
        <div className="absolute bottom-4 left-[0.67rem] top-4 w-px bg-border" aria-hidden />
        <Lane
          label="Now"
          cards={lanes.now}
          tone="active"
          slug={slug}
          workspaceKey={workspaceKey}
          timezone={timezone}
        />
        <Lane
          label="Next"
          cards={lanes.next}
          tone="neutral"
          slug={slug}
          workspaceKey={workspaceKey}
          timezone={timezone}
        />
        <Lane
          label="Waiting"
          cards={lanes.waiting}
          tone="waiting"
          slug={slug}
          workspaceKey={workspaceKey}
          timezone={timezone}
        />
      </div>
    </section>
  );
}

function Lane({
  label,
  cards,
  tone,
  slug,
  workspaceKey,
  timezone,
}: {
  label: string;
  cards: DashboardWorkCard[];
  tone: "active" | "neutral" | "waiting";
  slug: string;
  workspaceKey: string;
  timezone: string | null;
}) {
  if (cards.length === 0) return null;
  const nodeTone =
    tone === "active"
      ? "text-ember"
      : tone === "waiting"
        ? "text-sky-400"
        : "text-muted-foreground";
  return (
    <section className="relative pb-4 last:pb-0" data-dashboard-lane={label.toLowerCase()}>
      <CircleDot
        className={cn("absolute -left-[1.93rem] top-0.5 h-4 w-4 bg-background", nodeTone)}
        aria-hidden
      />
      <header className="mb-1.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide">{label}</h3>
        <span className="rounded-full bg-subtle px-1.5 font-mono text-[0.625rem] text-muted-foreground">
          {cards.length}
        </span>
      </header>
      <ul className="divide-y divide-border/80 border-y border-border/80">
        {cards.map((card) => (
          <li key={card.id}>
            <WorkRow card={card} slug={slug} workspaceKey={workspaceKey} timezone={timezone} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function WorkRow({
  card,
  slug,
  workspaceKey,
  timezone,
}: {
  card: DashboardWorkCard;
  slug: string;
  workspaceKey: string;
  timezone: string | null;
}) {
  const owner = card.assignees[0]?.user ?? null;
  return (
    <Link
      href={`/w/${slug}/issues/${card.id}`}
      className="focus-ring group grid min-w-0 grid-cols-[1.75rem_4rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-1 py-2 hover:bg-subtle/35 md:grid-cols-[1.75rem_4rem_minmax(0,1fr)_auto_auto_auto]"
    >
      <span
        className={cn(
          "text-center font-mono text-[0.6875rem]",
          card.priority === "URGENT" || card.priority === "HIGH"
            ? "text-ember"
            : "text-muted-foreground",
        )}
      >
        {PRIORITY_GLYPH[card.priority] ?? "—"}
      </span>
      <span className="text-id text-muted-foreground">
        {formatIssueId(workspaceKey, card.number)}
      </span>
      <span className="min-w-0 truncate text-[0.8125rem] group-hover:text-foreground">
        {card.title}
      </span>
      <span className="hidden md:block">
        {card.project ? (
          <Badge color={card.project.color ?? undefined}>{card.project.key}</Badge>
        ) : (
          <span className="text-meta text-muted-foreground">—</span>
        )}
      </span>
      <Badge className="max-w-28 truncate" color={card.status.color}>
        {card.status.name}
      </Badge>
      <span className="text-meta hidden min-w-20 justify-end gap-1 text-muted-foreground md:flex">
        {card.dueDate ? (
          <span className="inline-flex items-center gap-1">
            <Clock3 className="h-3 w-3" /> {formatDueDate(card.dueDate, timezone)}
          </span>
        ) : owner ? (
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={owner.name} image={owner.image} size={18} />
            <span className="max-w-20 truncate">{owner.name ?? "Assignee"}</span>
          </span>
        ) : card.assignedAgent ? (
          <span className="max-w-24 truncate">@{card.assignedAgent.profileKey}</span>
        ) : (
          "—"
        )}
      </span>
    </Link>
  );
}

type AttentionTab = "decisions" | "exceptions" | "blocked";

function AttentionRail({ slug }: { slug: string }) {
  const { data, isLoading } = trpc.commandCenter.summary.useQuery(
    { limit: 8 },
    { refetchOnWindowFocus: true, staleTime: 30_000 },
  );
  const [tab, setTab] = useState<AttentionTab>("decisions");

  const decisions = useMemo(() => {
    if (!data) return [];
    return [
      ...data.actionRequests.map((request) => ({
        id: `request-${request.id}`,
        title: request.issue?.title ?? request.title,
        detail: request.title,
        href: request.issue
          ? `/w/${request.issue.workspace.slug}/issues/${request.issue.id}`
          : `/w/${slug}/command-center`,
      })),
      ...data.reviewGates.map((gate) => ({
        id: `gate-${gate.id}`,
        title: gate.prompt,
        detail: "Review required",
        href: `/w/${slug}/command-center`,
      })),
      ...data.runtimeApprovals.map((run) => ({
        id: `approval-${run.id}`,
        title: run.issue.title,
        detail: "Runtime approval required",
        href: `/w/${slug}/issues/${run.issue.id}`,
      })),
    ];
  }, [data, slug]);

  const exceptions = useMemo(() => {
    if (!data) return [];
    return [
      ...data.stalledRuns.map((run) => ({
        id: `stalled-${run.id}`,
        title: run.issue.title,
        detail: run.recoveryTitle ?? "Agent run needs recovery",
        href: `/w/${slug}/issues/${run.issue.id}`,
      })),
      ...data.activeRuns
        .filter((run) => run.status === "WAITING")
        .map((run) => ({
          id: `waiting-${run.id}`,
          title: run.issue.title,
          detail: "Agent is waiting",
          href: `/w/${slug}/issues/${run.issue.id}`,
        })),
    ];
  }, [data, slug]);

  const blocked =
    data?.stalledRuns.map((run) => ({
      id: `blocked-${run.id}`,
      title: run.issue.title,
      detail: run.recoveryDetail ?? "Work is blocked",
      href: `/w/${slug}/issues/${run.issue.id}`,
    })) ?? [];
  const activeItems = tab === "decisions" ? decisions : tab === "exceptions" ? exceptions : blocked;
  const total = decisions.length + exceptions.length + blocked.length;

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card/40"
      data-testid="dashboard-attention-rail"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Inbox className="h-3.5 w-3.5 text-ember" aria-hidden />
        <h2 className="text-sm font-semibold">Needs attention</h2>
        {total > 0 && (
          <span className="rounded-full bg-subtle px-1.5 font-mono text-[0.625rem] text-muted-foreground">
            {total}
          </span>
        )}
      </header>
      <div
        className="flex overflow-x-auto border-b border-border px-2"
        role="tablist"
        aria-label="Attention type"
      >
        <AttentionTabButton
          active={tab === "decisions"}
          count={decisions.length}
          onClick={() => setTab("decisions")}
        >
          Decisions
        </AttentionTabButton>
        <AttentionTabButton
          active={tab === "exceptions"}
          count={exceptions.length}
          onClick={() => setTab("exceptions")}
        >
          Agent exceptions
        </AttentionTabButton>
        <AttentionTabButton
          active={tab === "blocked"}
          count={blocked.length}
          onClick={() => setTab("blocked")}
        >
          Blocked
        </AttentionTabButton>
      </div>
      <div role="tabpanel" className="min-h-32 p-2">
        {isLoading ? (
          <div className="h-24 animate-pulse rounded bg-subtle/40" />
        ) : activeItems.length === 0 ? (
          <div className="text-meta flex min-h-28 flex-col items-center justify-center text-center text-muted-foreground">
            <CheckCircle2 className="mb-2 h-4 w-4 text-success" />
            All clear in this view.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {activeItems.slice(0, 3).map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className="group block rounded px-2 py-2.5 hover:bg-subtle/35"
                >
                  <div className="line-clamp-1 text-xs font-medium">{item.title}</div>
                  <div className="text-meta mt-1 flex items-center gap-1 text-muted-foreground">
                    <AlertTriangle className="h-3 w-3 shrink-0 text-ember" />
                    <span className="line-clamp-1 min-w-0 flex-1">{item.detail}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {activeItems.length > 0 && (
          <Link
            href={`/w/${slug}/command-center`}
            className="text-meta mt-1 inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:text-foreground"
          >
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </section>
  );
}

function AttentionTabButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "focus-ring relative shrink-0 px-2.5 py-2 text-[0.6875rem] text-muted-foreground hover:text-foreground",
        active &&
          "text-ember after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-ember",
      )}
    >
      {children}
      {count > 0 && <span className="ml-1 text-[0.625rem] text-muted-foreground">{count}</span>}
    </button>
  );
}

function WorkspaceHealthDrawer({ slug }: { slug: string }) {
  const { data: account } = trpc.user.me.useQuery();
  const active = trpc.issue.list.useQuery({ includeDone: false, limit: 200 });
  const done = trpc.issue.list.useQuery({ includeDone: true, limit: 200 });
  const statuses = trpc.status.list.useQuery();
  const standup = trpc.standup.draft.useQuery({ sinceHours: 24 });
  const changelog = trpc.system.changelog.useQuery({ limit: 2 });
  const utils = trpc.useUtils();
  const savePrefs = trpc.user.setDashboardPrefs.useMutation({
    onSettled: () => utils.user.me.invalidate(),
  });
  const markSeen = trpc.user.markChangelogSeen.useMutation({
    onSuccess: () => utils.user.me.invalidate(),
  });
  const [collapsed, setCollapsed] = useState(false);
  const [clearedRelease, setClearedRelease] = useState<string | null>(null);

  const dashboardPrefs = account?.dashboardPrefs as {
    version?: number;
    order?: string[];
    hidden?: string[];
    collapsed?: string[];
    widths?: Record<string, "half" | "full">;
  } | null;

  useEffect(() => {
    setCollapsed(Boolean(dashboardPrefs?.collapsed?.includes(HEALTH_DRAWER_ID)));
  }, [dashboardPrefs?.collapsed]);

  const latest = changelog.data?.entries.find((entry) => entry.date) ?? null;
  const unseen =
    !!latest &&
    latest.id !== clearedRelease &&
    hasUnseenChangelog(
      latest,
      account?.changelogSeenRelease ?? null,
      account?.changelogSeenAt ?? null,
    );

  function toggleDrawer() {
    const next = !collapsed;
    setCollapsed(next);
    const current = new Set(dashboardPrefs?.collapsed ?? []);
    if (next) current.add(HEALTH_DRAWER_ID);
    else current.delete(HEALTH_DRAWER_ID);
    savePrefs.mutate({
      version: DASHBOARD_LAYOUT_VERSION,
      order: dashboardPrefs?.order ?? [],
      hidden: dashboardPrefs?.hidden ?? [],
      widths: dashboardPrefs?.widths ?? {},
      collapsed: [...current],
    });
  }

  function clearWhatsNew() {
    if (!latest) return;
    setClearedRelease(latest.id);
    markSeen.mutate({ releaseId: latest.id });
  }

  const activeItems = active.data?.items ?? [];
  const counts = new Map<string, number>();
  for (const issue of activeItems)
    counts.set(issue.statusId, (counts.get(issue.statusId) ?? 0) + 1);
  const visibleStatuses = (statuses.data ?? []).filter(
    (status) => status.category !== "DONE" && status.category !== "CANCELED",
  );
  const totalActive = Math.max(1, activeItems.length);
  const inProgress = activeItems.filter((issue) => issue.status.category === "IN_PROGRESS").length;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const doneThisWeek =
    done.data?.items.filter(
      (issue) => issue.status.category === "DONE" && new Date(issue.updatedAt).getTime() >= weekAgo,
    ).length ?? 0;
  const blocked = standup.data?.counts.blocked ?? 0;

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-card/85 backdrop-blur-sm"
      data-testid="dashboard-health-drawer"
    >
      <button
        type="button"
        onClick={toggleDrawer}
        className="focus-ring flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-subtle/30"
        aria-expanded={!collapsed}
        aria-controls="dashboard-health-content"
      >
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-sm font-medium">Workspace health</span>
        <span className="text-meta text-muted-foreground">live operational summary</span>
        {collapsed ? (
          <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div
          id="dashboard-health-content"
          className="grid grid-cols-1 divide-y divide-border border-t border-border md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-4"
        >
          <section className="min-w-0 p-4" aria-labelledby="health-pipeline-heading">
            <HealthHeading id="health-pipeline-heading" label="Pipeline" hint="active work" />
            <div className="mt-5 flex h-2 overflow-hidden rounded-full bg-subtle">
              {visibleStatuses.map((status) => {
                const count = counts.get(status.id) ?? 0;
                return (
                  <span
                    key={status.id}
                    style={{
                      width: `${(count / totalActive) * 100}%`,
                      backgroundColor: status.color,
                    }}
                    title={`${status.name}: ${count}`}
                  />
                );
              })}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
              {visibleStatuses.map((status) => (
                <div
                  key={status.id}
                  className="text-meta flex items-center gap-2 text-muted-foreground"
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: status.color }}
                  />
                  <span className="truncate">{status.name}</span>
                  <span className="ml-auto font-mono tabular-nums text-foreground">
                    {counts.get(status.id) ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="min-w-0 p-4" aria-labelledby="health-throughput-heading">
            <HealthHeading id="health-throughput-heading" label="Throughput" hint="last 7 days" />
            <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border">
              <Metric label="Open" value={activeItems.length} />
              <Metric label="In progress" value={inProgress} />
              <Metric label="Done / wk" value={doneThisWeek} />
              <Metric label="Blocked" value={blocked} />
            </div>
          </section>

          <section className="min-w-0 p-4" aria-labelledby="health-standup-heading">
            <HealthHeading
              id="health-standup-heading"
              label="Standup"
              hint="last 24h"
              href={`/w/${slug}/standup`}
            />
            <div className="mt-4 space-y-2">
              <StandupMetric
                label="Closed"
                value={standup.data?.counts.closed ?? 0}
                tone="bg-success"
              />
              <StandupMetric
                label="Opened"
                value={standup.data?.counts.opened ?? 0}
                tone="bg-sky-400"
              />
              <StandupMetric
                label="Continuing"
                value={standup.data?.counts.inProgress ?? 0}
                tone="bg-warning"
              />
              <StandupMetric label="Blocked" value={blocked} tone="bg-danger" />
            </div>
          </section>

          <section className="min-w-0 p-4" aria-labelledby="health-changelog-heading">
            <div className="flex min-w-0 items-start gap-2">
              <HealthHeading
                id="health-changelog-heading"
                label="What's new"
                hint={unseen ? "new release" : "caught up"}
              />
              {unseen && (
                <span
                  className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-ember"
                  aria-label="New release notes"
                />
              )}
              {unseen && (
                <button
                  type="button"
                  onClick={clearWhatsNew}
                  className="focus-ring text-meta ml-auto shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                  title="Hide these notes until the next release"
                >
                  Clear
                </button>
              )}
            </div>
            {unseen && latest ? (
              <>
                <div className="mt-3 line-clamp-1 text-xs font-medium">{latest.heading}</div>
                <ul className="mt-2 space-y-1.5">
                  {latest.items.slice(0, 3).map((item, index) => (
                    <li
                      key={`${item.type}-${index}`}
                      className="text-meta flex min-w-0 items-center gap-2 text-muted-foreground"
                    >
                      <span className="shrink-0 rounded border border-border bg-subtle px-1 font-mono text-[0.5625rem] uppercase">
                        {item.type}
                      </span>
                      <span className="truncate">{item.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="text-meta mt-4 text-muted-foreground">
                You&apos;re caught up. New release notes will appear here automatically.
              </div>
            )}
            <Link
              href={`/w/${slug}/whats-new`}
              className="text-meta mt-3 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              View all changes <ArrowRight className="h-3 w-3" />
            </Link>
          </section>
        </div>
      )}
    </section>
  );
}

function HealthHeading({
  id,
  label,
  hint,
  href,
}: {
  id: string;
  label: string;
  hint: string;
  href?: string;
}) {
  const content = (
    <div className="min-w-0">
      <h3 id={id} className="text-xs font-semibold uppercase tracking-wide">
        {label}
      </h3>
      <p className="text-meta text-muted-foreground">{hint}</p>
    </div>
  );
  return href ? (
    <Link href={href} className="hover:text-ember">
      {content}
    </Link>
  ) : (
    content
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-background/70 px-3 py-2">
      <div className="text-[0.625rem] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StandupMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("h-1.5 w-1.5 rounded-full", tone)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono tabular-nums">{value}</span>
    </div>
  );
}
