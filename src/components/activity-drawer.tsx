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
  Bot,
  Clock,
  FilePlus,
  History,
  Inbox,
  MessageCircle,
  UserCheck,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
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

export function useActivityDrawer(): {
  open: boolean;
  toggle: () => void;
  unreadCount: number;
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

  const { data } = trpc.event.unreadCount.useQuery(
    { since },
    { enabled: Boolean(ws), refetchOnWindowFocus: false },
  );

  const utils = trpc.useUtils();
  useRealtime(
    () => {
      if (!ws) return;
      void utils.event.unreadCount.invalidate();
      void utils.event.recent.invalidate();
    },
    { kind: KINDS },
  );

  const toggle = useCallback(() => {
    setDrawerState({ open: !drawerState.open });
  }, []);

  return { open: state.open, toggle, unreadCount: data?.count ?? 0 };
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

export default function ActivityDrawer() {
  const ws = useMaybeWorkspace();
  const state = useSyncExternalStore(
    subscribeDrawer,
    getDrawerSnapshot,
    getServerSnapshot,
  );
  const open = state.open;

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
    { enabled: Boolean(ws) && (open || hasOpenedOnce) },
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
        <div className="sticky top-0 flex items-center gap-2 border-b border-border bg-card px-4 py-3">
          <div className="text-sm font-semibold tracking-tight">Activity</div>
          <div className="ml-auto flex items-center gap-1.5">
            <label
              className={cn(
                "inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
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
            <button
              type="button"
              onClick={markAllRead}
              className={cn(
                "focus-ring rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-subtle hover:text-foreground",
                MOTION.fast,
              )}
            >
              Mark all read
            </button>
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && events.length === 0 ? (
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
                    className="flex items-start gap-2 px-4 py-2.5 text-[12px]"
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

          {nextCursor && (
            <div className="flex justify-center px-4 py-3">
              <button
                type="button"
                onClick={() => setCursor(nextCursor)}
                className={cn(
                  "focus-ring inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground",
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
