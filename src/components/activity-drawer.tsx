"use client";

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  AtSign,
  Bell,
  Bot,
  Clock,
  FilePlus,
  History,
  Inbox,
  MessageCircle,
  UserCheck,
  X,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { useCrossTab, useRealtime } from "@/hooks/use-realtime";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn, relativeTime } from "@/lib/utils";
import { EmptyState, MOTION, SkeletonList } from "@/components/ui";

type Kind =
  | "ISSUE_CREATED"
  | "ISSUE_STATUS_CHANGED"
  | "ISSUE_ASSIGNED"
  | "ISSUE_PRIORITY_CHANGED"
  | "ISSUE_QUEUED"
  | "ISSUE_STALLED"
  | "ISSUE_SLA_BREACH"
  | "COMMENT_CREATED"
  | "AGENT_ASSIGNED"
  | "AGENT_NOACK"
  | "AGENT_STATUS_CHANGED";

type TimelineEvent = {
  id: string;
  kind: Kind;
  createdAt: Date | string;
  actor: { id: string; name: string | null; image: string | null } | null;
  subjectType: string;
  subjectId: string;
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { key: string };
    status: { id: string; name: string; color: string; category: string };
    project: { id: string; key: string; name: string; color: string | null } | null;
    assignedAgent: { id: string; name: string; profileKey: string } | null;
  } | null;
  agent: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
    status: "ONLINE" | "BUSY" | "OFFLINE";
  } | null;
  payload: unknown;
};

const KINDS: Kind[] = [
  "ISSUE_CREATED",
  "ISSUE_STATUS_CHANGED",
  "ISSUE_ASSIGNED",
  "ISSUE_PRIORITY_CHANGED",
  "ISSUE_QUEUED",
  "ISSUE_STALLED",
  "ISSUE_SLA_BREACH",
  "COMMENT_CREATED",
  "AGENT_ASSIGNED",
  "AGENT_NOACK",
  "AGENT_STATUS_CHANGED",
];

const LAST_READ_KEY = "forge.activityDrawer.lastReadAt";

// Module-scoped store so the topbar bell and the drawer panel share state
// without prop-drilling or wrapping the whole tree in another provider.
type DrawerState = { open: boolean };
let drawerState: DrawerState = { open: false };
const drawerListeners = new Set<() => void>();

function setDrawerState(next: DrawerState) {
  drawerState = next;
  for (const fn of drawerListeners) fn();
}

function subscribeDrawer(fn: () => void) {
  drawerListeners.add(fn);
  return () => {
    drawerListeners.delete(fn);
  };
}

function getDrawerSnapshot(): DrawerState {
  return drawerState;
}

function getServerSnapshot(): DrawerState {
  return { open: false };
}

function readLastRead(): string {
  if (typeof window === "undefined") {
    return new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  }
  const stored = window.localStorage.getItem(LAST_READ_KEY);
  if (stored) return stored;
  const fallback = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  window.localStorage.setItem(LAST_READ_KEY, fallback);
  return fallback;
}

function writeLastRead(iso: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAST_READ_KEY, iso);
}

const lastReadListeners = new Set<() => void>();

function notifyLastRead() {
  for (const fn of lastReadListeners) fn();
}

function subscribeLastRead(fn: () => void) {
  lastReadListeners.add(fn);
  return () => {
    lastReadListeners.delete(fn);
  };
}

function getLastReadSnapshot(): string {
  return readLastRead();
}

function getLastReadServerSnapshot(): string {
  return new Date(0).toISOString();
}

/**
 * Drawer-and-bell hook.
 *
 * `unreadCount` is sourced from `inbox.badge` — the count of items
 * needing my attention (assigned + mentions + stalled). That's what
 * the bell number actually means now: "how many things should I look
 * at." The realtime event stream keeps a separate "unread events"
 * counter for the Activity tab itself, but it doesn't drive the bell.
 */
export function useActivityDrawer(): {
  open: boolean;
  toggle: () => void;
  unreadCount: number;
  eventUnreadCount: number;
} {
  const ws = useMaybeWorkspace();
  const state = useSyncExternalStore(
    subscribeDrawer,
    getDrawerSnapshot,
    getServerSnapshot,
  );
  const lastReadIso = useSyncExternalStore(
    subscribeLastRead,
    getLastReadSnapshot,
    getLastReadServerSnapshot,
  );

  const since = ws ? new Date(lastReadIso) : undefined;

  const { data: eventUnread } = trpc.event.unreadCount.useQuery(
    { since },
    { enabled: Boolean(ws), refetchOnWindowFocus: false },
  );

  const { data: inboxBadge } = trpc.inbox.badge.useQuery(undefined, {
    enabled: Boolean(ws),
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });

  const utils = trpc.useUtils();
  useRealtime(
    () => {
      if (!ws) return;
      void utils.event.unreadCount.invalidate();
      void utils.event.recent.invalidate();
      void utils.inbox.badge.invalidate();
    },
    { kind: KINDS },
  );
  useRealtime(
    () => {
      if (!ws) return;
      void utils.inbox.badge.invalidate();
    },
    { kindPrefix: "COMMENT_" },
  );
  useCrossTab((msg) => {
    if (msg.type === "inbox:refresh") {
      void utils.inbox.badge.invalidate();
    }
  });

  const toggle = useCallback(() => {
    setDrawerState({ open: !drawerState.open });
  }, []);

  return {
    open: state.open,
    toggle,
    unreadCount: inboxBadge?.count ?? 0,
    eventUnreadCount: eventUnread?.count ?? 0,
  };
}

/**
 * Bell button — opens the activity drawer. Badge counts items that
 * need the user's attention (mentions, assigned, stalled) so the
 * number always means the same thing. Tooltip spells it out.
 */
export function ActivityBell() {
  const ws = useMaybeWorkspace();
  const { toggle, unreadCount } = useActivityDrawer();
  if (!ws) return null;
  const tip =
    unreadCount > 0
      ? `${unreadCount} ${unreadCount === 1 ? "item needs" : "items need"} your attention`
      : "No items need your attention";
  return (
    <button
      type="button"
      onClick={toggle}
      title={tip}
      aria-label={tip}
      className="focus-ring relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground"
    >
      <Bell className="h-3.5 w-3.5" />
      {unreadCount > 0 && (
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center",
            "rounded-full bg-ember px-1 text-[0.6875rem] font-mono font-semibold text-ember-foreground",
          )}
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>
  );
}

function iconFor(kind: Kind) {
  switch (kind) {
    case "AGENT_ASSIGNED":
    case "ISSUE_ASSIGNED":
      return <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />;
    case "AGENT_STATUS_CHANGED":
      return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_CREATED":
      return <FilePlus className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_STATUS_CHANGED":
      return <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_PRIORITY_CHANGED":
      return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_STALLED":
      return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    case "AGENT_NOACK":
      return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    case "ISSUE_SLA_BREACH":
      return <Clock className="h-3.5 w-3.5 text-danger" />;
    case "ISSUE_QUEUED":
      return <Inbox className="h-3.5 w-3.5 text-muted-foreground" />;
    case "COMMENT_CREATED":
      return <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return <Bot className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === "object" && key in payload) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function summarizeEvent(
  evt: TimelineEvent,
  wsSlug: string,
): { headline: ReactNode; meta?: ReactNode } {
  const actorName = evt.actor?.name ?? "system";
  const issue = evt.issue;
  const issueLabel = issue
    ? `${issue.workspace.key}-${issue.number}`
    : null;
  const issueHref = issue ? `/w/${wsSlug}/issues/${issue.id}` : null;
  const issueLink =
    issue && issueHref ? (
      <Link
        href={issueHref}
        className="font-mono text-foreground hover:text-ember"
      >
        {issueLabel}
      </Link>
    ) : (
      <span className="text-muted-foreground">an issue</span>
    );

  switch (evt.kind) {
    case "ISSUE_CREATED":
      return {
        headline: (
          <>
            {actorName} created {issueLink}
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    case "ISSUE_ASSIGNED": {
      const agentHandle =
        evt.agent?.profileKey ?? evt.issue?.assignedAgent?.profileKey;
      return {
        headline: (
          <>
            {actorName} assigned {issueLink}
            {agentHandle && (
              <>
                {" "}
                to <span className="font-mono">@{agentHandle}</span>
              </>
            )}
          </>
        ),
      };
    }
    case "AGENT_ASSIGNED": {
      const mode = readPayloadString(evt.payload, "mode");
      const agentHandle =
        evt.agent?.profileKey ?? evt.issue?.assignedAgent?.profileKey;
      return {
        headline: (
          <>
            {actorName} assigned {issueLink}
            {agentHandle && (
              <>
                {" "}
                to <span className="font-mono">@{agentHandle}</span>
              </>
            )}
          </>
        ),
        meta: mode ? <>mode &middot; {mode}</> : undefined,
      };
    }
    case "AGENT_STATUS_CHANGED": {
      const status = readPayloadString(evt.payload, "status");
      const agentName = evt.agent?.name ?? "Agent";
      return {
        headline: status ? (
          <>
            {agentName} went {status}
          </>
        ) : (
          <>{agentName} status changed</>
        ),
      };
    }
    case "ISSUE_STATUS_CHANGED":
      return {
        headline: (
          <>
            {actorName} moved {issueLink}
            {issue && (
              <>
                {" "}
                &rarr;{" "}
                <span style={{ color: issue.status.color }}>
                  {issue.status.name}
                </span>
              </>
            )}
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    case "ISSUE_PRIORITY_CHANGED": {
      const to = readPayloadString(evt.payload, "to");
      return {
        headline: (
          <>
            {actorName} changed priority on {issueLink}
            {to && (
              <>
                {" "}
                &rarr; <span className="text-foreground">{to}</span>
              </>
            )}
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    }
    case "ISSUE_QUEUED":
      return {
        headline: (
          <>
            {actorName} queued {issueLink} for an agent
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    case "ISSUE_STALLED": {
      const handle = readPayloadString(evt.payload, "agentProfileKey");
      return {
        headline: (
          <>
            Stalled — {issueLink}{" "}
            <span className="text-muted-foreground">
              hadn&apos;t moved
              {handle && (
                <>
                  {" "}
                  (assigned <span className="font-mono">@{handle}</span>)
                </>
              )}
            </span>
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    }
    case "AGENT_NOACK": {
      const handle = readPayloadString(evt.payload, "agentProfileKey");
      const seconds =
        evt.payload && typeof evt.payload === "object"
          ? (evt.payload as Record<string, unknown>).requiredAckSeconds
          : null;
      const secNum =
        typeof seconds === "number" ? Math.round(seconds) : null;
      return {
        headline: (
          <>
            <span className="text-warning">Missed wake</span> — {issueLink}{" "}
            <span className="text-muted-foreground">
              {handle && (
                <>
                  <span className="font-mono">@{handle}</span> didn&apos;t ack
                </>
              )}
              {secNum != null && <> within {secNum}s</>}
            </span>
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    }
    case "ISSUE_SLA_BREACH": {
      const overdue =
        evt.payload && typeof evt.payload === "object"
          ? (evt.payload as Record<string, unknown>).breachedByMinutes
          : null;
      const overdueNum =
        typeof overdue === "number" ? Math.max(0, overdue) : null;
      return {
        headline: (
          <>
            <span className="text-danger">SLA breach</span> — {issueLink}{" "}
            {overdueNum != null && (
              <span className="text-muted-foreground">
                {overdueNum}m overdue
              </span>
            )}
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    }
    case "COMMENT_CREATED":
      return {
        headline: (
          <>
            {actorName}
            {evt.agent && (
              <>
                {" "}
                <span className="font-mono">@{evt.agent.profileKey}</span>
              </>
            )}{" "}
            commented on {issueLink}
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
  }
}

type Tab = "mine" | "activity";

export default function ActivityDrawer() {
  const ws = useMaybeWorkspace();
  const state = useSyncExternalStore(
    subscribeDrawer,
    getDrawerSnapshot,
    getServerSnapshot,
  );
  const open = state.open;

  const [tab, setTab] = useState<Tab>("mine");
  const [hasOpenedOnce, setHasOpenedOnce] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<TimelineEvent[]>([]);

  useEffect(() => {
    if (open) setHasOpenedOnce(true);
  }, [open]);

  // Reset accumulated pages when filter flips so we don't mix mine/all rows.
  useEffect(() => {
    setPages([]);
    setCursor(undefined);
  }, [mineOnly]);

  const close = useCallback(() => {
    setDrawerState({ open: false });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Auto mark-as-read 1s after the drawer opens, so the badge clears once
  // the user has actually seen the panel rather than the moment they click.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      writeLastRead(new Date().toISOString());
      notifyLastRead();
    }, 1000);
    return () => window.clearTimeout(t);
  }, [open]);

  const { data, isLoading } = trpc.event.recent.useQuery(
    { cursor, limit: 40, mineOnly },
    {
      enabled:
        Boolean(ws) && (open || hasOpenedOnce) && tab === "activity",
    },
  );

  // Mine tab: pulls the same payload that powers /inbox so the badge
  // count, the drawer preview, and the full page all share a source.
  const { data: mineData, isLoading: mineLoading } = trpc.inbox.get.useQuery(
    { allWorkspaces: false },
    {
      enabled: Boolean(ws) && (open || hasOpenedOnce) && tab === "mine",
      refetchOnWindowFocus: true,
      staleTime: 30_000,
    },
  );

  useEffect(() => {
    if (!data) return;
    const incoming = data.events as unknown as TimelineEvent[];
    setPages((prev) => {
      if (cursor === undefined) return incoming;
      const seen = new Set(prev.map((e) => e.id));
      return [...prev, ...incoming.filter((e) => !seen.has(e.id))];
    });
  }, [data, cursor]);

  const utils = trpc.useUtils();

  const markAllRead = useCallback(() => {
    writeLastRead(new Date().toISOString());
    notifyLastRead();
    void utils.event.unreadCount.invalidate();
  }, [utils]);

  if (!ws || !open) return null;

  const events = pages;
  const nextCursor = data?.nextCursor ?? null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={close}
      aria-hidden="true"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Activity"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "fixed right-0 top-0 z-40 flex h-svh w-[420px] max-w-full flex-col border-l border-border bg-card shadow-xl",
          "motion-safe:animate-in motion-safe:slide-in-from-right-4 motion-safe:fade-in duration-150 ease-out",
        )}
      >
        <div className="sticky top-0 z-10 border-b border-border bg-card">
          <div className="flex items-center gap-2 px-4 pt-3">
            <div className="text-sm font-semibold tracking-tight">
              Notifications
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {tab === "activity" && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className={cn(
                    "focus-ring rounded-md px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground",
                    MOTION.fast,
                  )}
                >
                  Mark all read
                </button>
              )}
              {ws && (
                <Link
                  href={`/w/${ws.slug}/inbox`}
                  onClick={close}
                  className={cn(
                    "focus-ring rounded-md px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground",
                    MOTION.fast,
                  )}
                  title="Open the full Inbox page (g i)"
                >
                  Open Inbox →
                </Link>
              )}
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className={cn(
                  "focus-ring rounded-md p-1 text-muted-foreground hover:bg-subtle hover:text-foreground",
                  MOTION.fast,
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1 px-2">
            <DrawerTab
              active={tab === "mine"}
              onClick={() => setTab("mine")}
              label="Mine"
              count={
                mineData
                  ? mineData.counts.assignedUnblocked +
                    mineData.counts.mentions +
                    mineData.counts.stalled
                  : undefined
              }
            />
            <DrawerTab
              active={tab === "activity"}
              onClick={() => setTab("activity")}
              label="Activity"
            />
            {tab === "activity" && (
              <label
                className={cn(
                  "ml-auto mr-2 inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.6875rem]",
                  MOTION.fast,
                  mineOnly
                    ? "border-ember bg-ember/10 text-ember"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={mineOnly}
                  onChange={(e) => setMineOnly(e.target.checked)}
                />
                Mine only
              </label>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "mine" ? (
            <MinePanel
              ws={ws}
              data={mineData}
              isLoading={mineLoading}
              onNavigate={close}
            />
          ) : isLoading && events.length === 0 ? (
            <div className="px-4 py-3">
              <SkeletonList rows={6} />
            </div>
          ) : events.length === 0 ? (
            <div className="px-4 py-6">
              <EmptyState
                variant="card"
                icon={<History />}
                title="Nothing yet."
                description="Activity from issues, comments, and agents will show up here."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {events.map((evt) => {
                const { headline, meta } = summarizeEvent(evt, ws.slug);
                return (
                  <li
                    key={evt.id}
                    className="flex items-start gap-2 px-4 py-2.5 text-[0.75rem]"
                  >
                    <span className="mt-0.5 shrink-0">{iconFor(evt.kind)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground">{headline}</div>
                      {meta && (
                        <div className="text-meta truncate text-muted-foreground">
                          {meta}
                        </div>
                      )}
                    </div>
                    <span className="text-meta shrink-0 text-muted-foreground">
                      {relativeTime(evt.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {tab === "activity" && nextCursor && (
            <div className="flex justify-center px-4 py-3">
              <button
                type="button"
                onClick={() => setCursor(nextCursor)}
                className={cn(
                  "focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground",
                  MOTION.fast,
                )}
              >
                Load older
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function DrawerTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-subtle text-foreground"
          : "text-muted-foreground hover:bg-subtle/60 hover:text-foreground",
      )}
    >
      {label}
      {typeof count === "number" && count > 0 && (
        <span
          className={cn(
            "inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 font-mono text-[0.625rem]",
            active
              ? "bg-ember/20 text-ember"
              : "bg-subtle text-muted-foreground",
          )}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

type InboxData = inferRouterOutputs<AppRouter>["inbox"]["get"];

function MinePanel({
  ws,
  data,
  isLoading,
  onNavigate,
}: {
  ws: { slug: string };
  data: InboxData | undefined;
  isLoading: boolean;
  onNavigate: () => void;
}) {
  if (isLoading && !data) {
    return (
      <div className="px-4 py-3">
        <SkeletonList rows={6} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          variant="card"
          icon={<Inbox />}
          title="Nothing here yet."
          description="Items assigned to you, mentions, and stalled work will appear here."
        />
      </div>
    );
  }

  const totalCount =
    data.counts.assignedUnblocked + data.counts.mentions + data.counts.stalled;

  if (totalCount === 0) {
    return (
      <div className="px-4 py-6">
        <EmptyState
          variant="card"
          icon={<Inbox />}
          title="You're caught up."
          description="No assigned, mentioned, or stalled items right now."
        />
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {data.counts.assignedUnblocked > 0 && (
        <MineSection
          title="Assigned"
          count={data.counts.assignedUnblocked}
          icon={<UserCheck className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          {data.assignedUnblocked.slice(0, 8).map((issue) => (
            <MineRow
              key={issue.id}
              href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
              onNavigate={onNavigate}
              left={
                <span className="font-mono text-[0.6875rem] text-muted-foreground">
                  {issue.workspace.key}-{issue.number}
                </span>
              }
              title={issue.title}
              meta={issue.status.name}
            />
          ))}
        </MineSection>
      )}

      {data.counts.mentions > 0 && (
        <MineSection
          title="Mentions"
          count={data.counts.mentions}
          icon={<AtSign className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          {data.mentions.slice(0, 8).map((c) => (
            <MineRow
              key={c.id}
              href={`/w/${c.issue.workspace.slug}/issues/${c.issue.id}`}
              onNavigate={onNavigate}
              left={
                <span className="font-mono text-[0.6875rem] text-muted-foreground">
                  {c.issue.workspace.key}-{c.issue.number}
                </span>
              }
              title={c.issue.title}
              meta={`${c.author.name ?? "someone"} · ${relativeTime(c.createdAt)}`}
            />
          ))}
        </MineSection>
      )}

      {data.counts.stalled > 0 && (
        <MineSection
          title="Stalled"
          count={data.counts.stalled}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          {data.stalled.slice(0, 8).map((issue) => (
            <MineRow
              key={issue.id}
              href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
              onNavigate={onNavigate}
              left={
                <span className="font-mono text-[0.6875rem] text-muted-foreground">
                  {issue.workspace.key}-{issue.number}
                </span>
              }
              title={issue.title}
              meta={`Last update ${relativeTime(issue.updatedAt)}`}
            />
          ))}
        </MineSection>
      )}

      <div className="flex justify-center px-4 py-3">
        <Link
          href={`/w/${ws.slug}/inbox`}
          onClick={onNavigate}
          className={cn(
            "focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[0.6875rem] text-muted-foreground hover:text-foreground",
            MOTION.fast,
          )}
        >
          See full Inbox →
        </Link>
      </div>
    </div>
  );
}

function MineSection({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="sticky top-0 flex items-center gap-1.5 bg-card/80 px-4 py-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur-sm">
        {icon}
        <span>{title}</span>
        <span className="ml-1 font-mono normal-case">{count}</span>
      </div>
      <ul>{children}</ul>
    </div>
  );
}

function MineRow({
  href,
  onNavigate,
  left,
  title,
  meta,
}: {
  href: string;
  onNavigate: () => void;
  left: ReactNode;
  title: string;
  meta?: string;
}) {
  return (
    <li>
      <Link
        href={href}
        onClick={onNavigate}
        className="flex items-start gap-2 px-4 py-2 text-[0.75rem] hover:bg-subtle/40"
      >
        <span className="mt-0.5 shrink-0">{left}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-foreground">{title}</div>
          {meta && (
            <div className="truncate text-[0.6875rem] text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}
