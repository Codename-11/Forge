"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRightLeft,
  AtSign,
  Bell,
  Bot,
  Check,
  Clock,
  FilePlus,
  History,
  Inbox,
  MessageCircle,
  CircleCheck,
  UserCheck,
  X,
} from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers/_app";
import { useCrossTab, useRealtime } from "@/hooks/use-realtime";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { cn, relativeTime } from "@/lib/utils";
import { activityActorName, activityActorOwnerTitle } from "@/lib/activity-actor";
import {
  getEventNotificationActionLinks,
  mapActivityEventToNotification,
  type EventNotificationMetadata,
} from "@/lib/notifications/event-notification";
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
  | "AGENT_STATUS_CHANGED"
  | "AGENT_RUN_STARTED"
  | "AGENT_RUN_BLOCKED"
  | "AGENT_RUN_COMPLETED"
  | "AGENT_RUN_STALLED"
  | "AGENT_RUN_CONTROL_REQUESTED"
  | "AGENT_RUN_KICKED";

type TimelineEvent = {
  id: string;
  kind: Kind;
  createdAt: Date | string;
  actor: { id: string; name: string | null; image: string | null } | null;
  actorAgent: {
    id: string;
    name: string | null;
    profileKey: string;
    avatar: string | null;
  } | null;
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

type NotificationRow = {
  id?: string;
  status?: "UNREAD" | "READ" | "DISMISSED" | "ACKNOWLEDGED" | "RESOLVED";
  event: TimelineEvent;
  notification: EventNotificationMetadata;
};

type PersistedNotificationRow =
  inferRouterOutputs<AppRouter>["notification"]["list"]["notifications"][number];

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
  "AGENT_RUN_STARTED",
  "AGENT_RUN_BLOCKED",
  "AGENT_RUN_COMPLETED",
  "AGENT_RUN_STALLED",
  "AGENT_RUN_CONTROL_REQUESTED",
  "AGENT_RUN_KICKED",
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
 * `unreadCount` combines the work inbox badge with persisted alert state.
 * The realtime event stream keeps a separate "unread events" counter for
 * the Activity tab itself, but it doesn't drive the bell by itself.
 */
export function useActivityDrawer(): {
  open: boolean;
  toggle: () => void;
  unreadCount: number;
  eventUnreadCount: number;
} {
  const ws = useMaybeWorkspace();
  const state = useSyncExternalStore(subscribeDrawer, getDrawerSnapshot, getServerSnapshot);
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

  const { data: notificationUnread } = trpc.notification.unreadCount.useQuery(undefined, {
    enabled: Boolean(ws),
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const utils = trpc.useUtils();
  useRealtime(
    () => {
      if (!ws) return;
      void utils.event.unreadCount.invalidate();
      void utils.event.recent.invalidate();
      void utils.notification.unreadCount.invalidate();
      void utils.notification.list.invalidate();
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
    unreadCount: (inboxBadge?.count ?? 0) + (notificationUnread?.count ?? 0),
    eventUnreadCount: eventUnread?.count ?? 0,
  };
}

/**
 * Bell button — opens the activity drawer. Badge counts what's *unread*:
 * notifications you haven't read plus inbox items (mentions, assigned,
 * stalled) updated since your last visit. Opening + closing the drawer,
 * visiting the Inbox, or pressing "M" there clears it; new activity
 * re-raises it. Tooltip spells it out.
 */
export function ActivityBell() {
  const ws = useMaybeWorkspace();
  const { toggle, unreadCount } = useActivityDrawer();
  if (!ws) return null;
  const tip =
    unreadCount > 0
      ? `${unreadCount} unread ${unreadCount === 1 ? "item" : "items"}`
      : "No unread items";
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
            "absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center",
            "rounded-full bg-ember px-1 font-mono text-[0.6875rem] font-semibold text-ember-foreground",
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
    case "AGENT_RUN_STARTED":
    case "AGENT_RUN_CONTROL_REQUESTED":
      return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
    case "AGENT_RUN_COMPLETED":
      return <CircleCheck className="h-3.5 w-3.5 text-success" />;
    case "ISSUE_CREATED":
      return <FilePlus className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_STATUS_CHANGED":
      return <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_PRIORITY_CHANGED":
      return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_STALLED":
      return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    case "AGENT_NOACK":
    case "AGENT_RUN_BLOCKED":
    case "AGENT_RUN_STALLED":
      return <AlertTriangle className="h-3.5 w-3.5 text-warning" />;
    case "ISSUE_SLA_BREACH":
      return <Clock className="h-3.5 w-3.5 text-danger" />;
    case "ISSUE_QUEUED":
      return <Inbox className="h-3.5 w-3.5 text-muted-foreground" />;
    case "COMMENT_CREATED":
      return <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />;
    case "AGENT_RUN_KICKED":
      return <Bot className="h-3.5 w-3.5 text-muted-foreground" />;
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

function readPayloadRecord(payload: unknown, key: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const v = (payload as Record<string, unknown>)[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readPayloadNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readPayloadBoolean(payload: unknown, key: string): boolean | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "boolean" ? v : null;
}

function readNestedString(payload: unknown, objectKey: string, valueKey: string): string | null {
  const obj = readPayloadRecord(payload, objectKey);
  const value = obj?.[valueKey];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function activityAgentHandle(evt: TimelineEvent): string | null {
  const dispatch = readPayloadRecord(evt.payload, "dispatch");
  const chosen = dispatch?.chosen;
  const chosenHandle =
    chosen && typeof chosen === "object" && !Array.isArray(chosen)
      ? (chosen as Record<string, unknown>).profileKey
      : null;
  return (
    evt.agent?.profileKey ??
    evt.issue?.assignedAgent?.profileKey ??
    readPayloadString(evt.payload, "agentProfileKey") ??
    (typeof chosenHandle === "string" && chosenHandle.length > 0 ? chosenHandle : null) ??
    readNestedString(evt.payload, "dispatchReason", "picked") ??
    null
  );
}

function agentHandleNode(handle: string | null): ReactNode {
  return handle ? <span className="font-mono">@{handle}</span> : "the agent";
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function runSummaryMeta(payload: unknown): ReactNode | undefined {
  const summary =
    readPayloadString(payload, "summary") ??
    readPayloadString(payload, "currentStep") ??
    readPayloadString(payload, "reason");
  return summary ? <span className="truncate">{summary}</span> : undefined;
}

function dispatchMeta(payload: unknown): ReactNode | undefined {
  const mode =
    readPayloadString(payload, "mode") ?? readNestedString(payload, "dispatchReason", "mode");
  const engagementMode = readPayloadString(payload, "engagementMode");
  const reason =
    readPayloadString(payload, "reason") ??
    readNestedString(payload, "dispatchReason", "reasonText");
  const parts = [
    mode ? `dispatch ${mode}` : null,
    engagementMode ? `mode ${engagementMode}` : null,
    reason,
  ].filter(Boolean);
  return parts.length > 0 ? <span className="truncate">{parts.join(" · ")}</span> : undefined;
}

function notificationForEvent(
  evt: TimelineEvent,
  ws: { slug: string; key: string },
): EventNotificationMetadata | null {
  return mapActivityEventToNotification({
    workspace: { slug: ws.slug, key: ws.key },
    event: {
      id: evt.id,
      kind: evt.kind,
      subjectType: evt.subjectType,
      subjectId: evt.subjectId,
      payload: evt.payload,
    },
    issue: evt.issue,
    agent: evt.agent,
  });
}

function notificationRowFromPersisted(row: PersistedNotificationRow): NotificationRow {
  return {
    id: row.id,
    status: row.status,
    event: row.event as unknown as TimelineEvent,
    notification: row.notification as EventNotificationMetadata,
  };
}

function severityLabel(severity: EventNotificationMetadata["severity"]): string {
  switch (severity) {
    case "CRITICAL":
      return "Critical";
    case "ERROR":
      return "Error";
    case "WARNING":
      return "Warning";
    case "SUCCESS":
      return "Success";
    case "INFO":
      return "Info";
  }
}

function severityBadgeClass(severity: EventNotificationMetadata["severity"]): string {
  switch (severity) {
    case "CRITICAL":
    case "ERROR":
      return "border-danger/30 bg-danger/10 text-danger";
    case "WARNING":
      return "border-warning/30 bg-warning/10 text-warning";
    case "SUCCESS":
      return "border-success/30 bg-success/10 text-success";
    case "INFO":
      return "border-border bg-subtle text-muted-foreground";
  }
}

function severityRowClass(severity: EventNotificationMetadata["severity"]): string {
  switch (severity) {
    case "CRITICAL":
    case "ERROR":
      return "bg-danger/5";
    case "WARNING":
      return "bg-warning/5";
    case "SUCCESS":
      return "bg-success/5";
    case "INFO":
      return "";
  }
}

function alertStatusLabel(status: NotificationRow["status"]): string | null {
  switch (status) {
    case "ACKNOWLEDGED":
      return "Acked";
    case "READ":
      return "Read";
    case "RESOLVED":
      return "Resolved";
    case "DISMISSED":
      return "Dismissed";
    case "UNREAD":
    case undefined:
      return null;
  }
}

function summarizeEvent(
  evt: TimelineEvent,
  wsSlug: string,
): { headline: ReactNode; meta?: ReactNode } {
  const actorLabel = activityActorName(evt);
  const actorOwnerTitle = activityActorOwnerTitle(evt);
  const actorName = actorOwnerTitle ? (
    <span title={actorOwnerTitle}>{actorLabel}</span>
  ) : (
    actorLabel
  );
  const issue = evt.issue;
  const issueLabel = issue ? `${issue.workspace.key}-${issue.number}` : null;
  const issueHref = issue ? `/w/${wsSlug}/issues/${issue.id}` : null;
  const issueLink =
    issue && issueHref ? (
      <Link href={issueHref} className="font-mono text-foreground hover:text-ember">
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
      const agentHandle = evt.agent?.profileKey ?? evt.issue?.assignedAgent?.profileKey;
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
      const agentHandle = activityAgentHandle(evt);
      const redirectedFromRunId = readPayloadString(evt.payload, "redirectedFromRunId");
      const auto = readPayloadBoolean(evt.payload, "auto") === true;
      return {
        headline: (
          <>
            {auto ? "Auto-dispatch" : actorName} requested wake for {agentHandleNode(agentHandle)}{" "}
            on {issueLink}
          </>
        ),
        meta: redirectedFromRunId ? <>redirected from previous run</> : dispatchMeta(evt.payload),
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
                &rarr; <span style={{ color: issue.status.color }}>{issue.status.name}</span>
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
      const secNum = typeof seconds === "number" ? Math.round(seconds) : null;
      return {
        headline: (
          <>
            <span className="text-warning">Wake missed</span> — {issueLink}{" "}
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
      const overdueNum = typeof overdue === "number" ? Math.max(0, overdue) : null;
      return {
        headline: (
          <>
            <span className="text-danger">SLA breach</span> — {issueLink}{" "}
            {overdueNum != null && (
              <span className="text-muted-foreground">{overdueNum}m overdue</span>
            )}
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    }
    case "COMMENT_CREATED":
      if (readPayloadString(evt.payload, "kind") === "STATUS") {
        return {
          headline: (
            <>
              {actorName} posted status output on {issueLink}
            </>
          ),
          meta:
            runSummaryMeta(evt.payload) ??
            (issue ? <span className="truncate">{issue.title}</span> : undefined),
        };
      }
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
    case "AGENT_RUN_STARTED": {
      const handle = activityAgentHandle(evt);
      return {
        headline: (
          <>
            Run opened for {agentHandleNode(handle)} on {issueLink}
          </>
        ),
        meta: <>waiting for wake delivery and acknowledgement</>,
      };
    }
    case "AGENT_RUN_CONTROL_REQUESTED": {
      const control = readPayloadString(evt.payload, "control");
      const label =
        control === "cancel"
          ? "Stop requested"
          : control === "pause"
            ? "Pause requested"
            : control === "redirect"
              ? "Redirect requested"
              : "Run control requested";
      return {
        headline: (
          <>
            {actorName} {label.toLowerCase()} for {issueLink}
          </>
        ),
        meta: runSummaryMeta(evt.payload),
      };
    }
    case "AGENT_RUN_COMPLETED": {
      const finalStatus = readPayloadString(evt.payload, "finalStatus");
      const handle = activityAgentHandle(evt);
      const verb =
        finalStatus === "ABANDONED"
          ? "stopped"
          : finalStatus === "STALLED"
            ? "stalled"
            : "completed";
      return {
        headline: (
          <>
            Run {verb} for {agentHandleNode(handle)} on {issueLink}
          </>
        ),
        meta:
          runSummaryMeta(evt.payload) ??
          (issue ? <span className="truncate">{issue.title}</span> : undefined),
      };
    }
    case "AGENT_RUN_STALLED":
      return {
        headline: (
          <>
            <span className="text-warning">Run stalled</span> for{" "}
            {agentHandleNode(activityAgentHandle(evt))} on {issueLink}
          </>
        ),
        meta:
          runSummaryMeta(evt.payload) ??
          (issue ? <span className="truncate">{issue.title}</span> : undefined),
      };
    case "AGENT_RUN_BLOCKED":
      return {
        headline: (
          <>
            Run blocked for {agentHandleNode(activityAgentHandle(evt))} on {issueLink}
          </>
        ),
        meta:
          runSummaryMeta(evt.payload) ??
          (issue ? <span className="truncate">{issue.title}</span> : undefined),
      };
    case "AGENT_RUN_KICKED": {
      const idleMs = readPayloadNumber(evt.payload, "idleMs");
      const handle = activityAgentHandle(evt);
      return {
        headline: (
          <>
            {actorName} retried wake for {agentHandleNode(handle)} on {issueLink}
          </>
        ),
        meta:
          idleMs != null ? (
            <>last signal {formatDuration(idleMs)} ago</>
          ) : (
            runSummaryMeta(evt.payload)
          ),
      };
    }
  }
  return {
    headline: (
      <>
        {actorName} recorded {String(evt.kind).replace(/_/g, " ").toLowerCase()} on {issueLink}
      </>
    ),
    meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
  };
}

function AlertActivityRow({
  row,
  onNavigate,
  onAcknowledge,
  onDismiss,
  onResolve,
  isMutating,
}: {
  row: NotificationRow;
  onNavigate: () => void;
  onAcknowledge?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onResolve?: (id: string) => void;
  isMutating?: boolean;
}) {
  const { event, notification } = row;
  const links = getEventNotificationActionLinks(notification);
  const stateId = row.id;
  const statusLabel = alertStatusLabel(row.status);
  const isClosed = row.status === "DISMISSED" || row.status === "RESOLVED";
  return (
    <li
      className={cn(
        "flex items-start gap-2 px-4 py-2.5 text-[0.75rem]",
        severityRowClass(notification.severity),
      )}
    >
      <span className="mt-0.5 shrink-0">{iconFor(event.kind)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "shrink-0 rounded-sm border px-1 py-0 text-[0.5625rem] font-semibold uppercase tracking-wider",
              severityBadgeClass(notification.severity),
            )}
          >
            {severityLabel(notification.severity)}
          </span>
          {statusLabel && (
            <span className="shrink-0 rounded-sm border border-border bg-subtle px-1 py-0 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
              {statusLabel}
            </span>
          )}
          <span className="min-w-0 truncate text-foreground">{notification.summary}</span>
        </div>
        {notification.reason && (
          <div className="text-meta mt-0.5 line-clamp-2 text-muted-foreground">
            {notification.reason}
          </div>
        )}
        <div className="text-meta mt-0.5 line-clamp-2 text-muted-foreground">
          {notification.recommendedAction}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {links.map((link) => (
            <Link
              key={`${link.kind}:${link.href}`}
              href={link.href}
              onClick={onNavigate}
              className={cn(
                "focus-ring rounded-sm text-[0.6875rem] font-medium hover:text-ember",
                link.kind === "primary" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {link.label}
            </Link>
          ))}
          {stateId && !isClosed && (
            <span className="ml-auto inline-flex items-center gap-1">
              {row.status === "ACKNOWLEDGED" ? (
                <button
                  type="button"
                  onClick={() => onResolve?.(stateId)}
                  disabled={isMutating || !onResolve}
                  title="Resolve alert"
                  aria-label="Resolve alert"
                  className="focus-ring inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50"
                >
                  <CircleCheck className="h-3 w-3" />
                  Resolve
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onAcknowledge?.(stateId)}
                  disabled={isMutating || !onAcknowledge}
                  title="Acknowledge alert"
                  aria-label="Acknowledge alert"
                  className="focus-ring inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50"
                >
                  <Check className="h-3 w-3" />
                  Ack
                </button>
              )}
              <button
                type="button"
                onClick={() => onDismiss?.(stateId)}
                disabled={isMutating || !onDismiss}
                title="Dismiss alert"
                aria-label="Dismiss alert"
                className="focus-ring inline-flex h-6 items-center gap-1 rounded-sm px-1.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50"
              >
                <Archive className="h-3 w-3" />
                Dismiss
              </button>
            </span>
          )}
        </div>
      </div>
      <span className="text-meta shrink-0 text-muted-foreground">
        {relativeTime(event.createdAt)}
      </span>
    </li>
  );
}

type Tab = "mine" | "activity";

export default function ActivityDrawer() {
  const ws = useMaybeWorkspace();
  const state = useSyncExternalStore(subscribeDrawer, getDrawerSnapshot, getServerSnapshot);
  const open = state.open;

  const [tab, setTab] = useState<Tab>("mine");
  const [hasOpenedOnce, setHasOpenedOnce] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [pages, setPages] = useState<TimelineEvent[]>([]);
  const utils = trpc.useUtils();

  const invalidateNotifications = useCallback(() => {
    void utils.notification.list.invalidate();
    void utils.notification.unreadCount.invalidate();
  }, [utils]);

  const markNotificationRead = trpc.notification.markRead.useMutation({
    onSuccess: invalidateNotifications,
  });
  const markNotificationReadMutate = markNotificationRead.mutate;
  const acknowledgeNotification = trpc.notification.acknowledge.useMutation({
    onSuccess: invalidateNotifications,
  });
  const dismissNotification = trpc.notification.dismiss.useMutation({
    onSuccess: invalidateNotifications,
  });
  const resolveNotification = trpc.notification.resolve.useMutation({
    onSuccess: invalidateNotifications,
  });
  // Closing the drawer also counts as "seeing" the inbox preview, so the
  // inbox-derived half of the bell badge (now a since-visit count) settles
  // to zero alongside the notification half. Server-debounced to 5s.
  const inboxVisit = trpc.inbox.visit.useMutation({
    onSuccess: () => void utils.inbox.badge.invalidate(),
  });
  const inboxVisitMutate = inboxVisit.mutate;
  const notificationMutating =
    markNotificationRead.isPending ||
    acknowledgeNotification.isPending ||
    dismissNotification.isPending ||
    resolveNotification.isPending;

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

  // Mark "seen" when the drawer CLOSES, not on a timer while it's open.
  // Opening to peek no longer wipes unread state mid-view, so the per-row
  // Ack/Dismiss/Resolve controls and the manual "Mark alerts read" button
  // stay meaningful — you act on items while looking, and the badge clears
  // only once you've actually looked and left. Clears both the activity
  // last-read anchor and the notification unread flags, and bumps the
  // inbox visit so the since-visit half of the badge settles too.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      writeLastRead(new Date().toISOString());
      notifyLastRead();
      markNotificationReadMutate({ all: true });
      inboxVisitMutate();
    }
    prevOpenRef.current = open;
  }, [open, markNotificationReadMutate, inboxVisitMutate]);

  const { data, isLoading } = trpc.event.recent.useQuery(
    { cursor, limit: 40, mineOnly },
    {
      enabled: Boolean(ws) && (open || hasOpenedOnce) && tab === "activity",
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

  const { data: attentionData, isLoading: attentionLoading } = trpc.notification.list.useQuery(
    { limit: 30 },
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

  const markAllRead = useCallback(() => {
    writeLastRead(new Date().toISOString());
    notifyLastRead();
    void utils.event.unreadCount.invalidate();
  }, [utils]);

  if (!ws || !open) return null;

  const events = pages;
  const nextCursor = data?.nextCursor ?? null;
  const attentionRows = attentionData?.notifications.map(notificationRowFromPersisted) ?? [];
  const unreadAlertCount = attentionRows.filter((row) => row.status === "UNREAD").length;
  const mineCount =
    (mineData
      ? mineData.counts.assignedUnblocked + mineData.counts.mentions + mineData.counts.stalled
      : 0) + attentionRows.length;

  return (
    <div
      className={cn("fixed inset-0 z-40 bg-foreground/20 backdrop-blur-sm", MOTION.fadeIn)}
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
          "duration-150 ease-out motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4",
        )}
      >
        <div className="sticky top-0 z-10 border-b border-border bg-card">
          <div className="flex items-center gap-2 px-4 pt-3">
            <div className="text-sm font-semibold tracking-tight">Notifications</div>
            <div className="ml-auto flex items-center gap-1.5">
              {tab === "mine" && unreadAlertCount > 0 && (
                <button
                  type="button"
                  onClick={() => markNotificationRead.mutate({ all: true })}
                  disabled={markNotificationRead.isPending}
                  className={cn(
                    "focus-ring rounded-md px-2 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50",
                    MOTION.fast,
                  )}
                >
                  Mark alerts read
                </button>
              )}
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
              count={mineData || attentionRows.length > 0 ? mineCount : undefined}
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
              alertRows={attentionRows}
              alertsLoading={attentionLoading}
              onAcknowledgeAlert={(id) => acknowledgeNotification.mutate({ id })}
              onDismissAlert={(id) => dismissNotification.mutate({ id })}
              onResolveAlert={(id) => resolveNotification.mutate({ id })}
              alertsMutating={notificationMutating}
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
                const notification = notificationForEvent(evt, ws);
                if (notification) {
                  return (
                    <AlertActivityRow
                      key={evt.id}
                      row={{ event: evt, notification }}
                      onNavigate={close}
                    />
                  );
                }
                const { headline, meta } = summarizeEvent(evt, ws.slug);
                return (
                  <li key={evt.id} className="flex items-start gap-2 px-4 py-2.5 text-[0.75rem]">
                    <span className="mt-0.5 shrink-0">{iconFor(evt.kind)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground">{headline}</div>
                      {meta && (
                        <div className="text-meta truncate text-muted-foreground">{meta}</div>
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
            active ? "bg-ember/20 text-ember" : "bg-subtle text-muted-foreground",
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
  alertRows,
  alertsLoading,
  onAcknowledgeAlert,
  onDismissAlert,
  onResolveAlert,
  alertsMutating,
  onNavigate,
}: {
  ws: { slug: string };
  data: InboxData | undefined;
  isLoading: boolean;
  alertRows: NotificationRow[];
  alertsLoading: boolean;
  onAcknowledgeAlert: (id: string) => void;
  onDismissAlert: (id: string) => void;
  onResolveAlert: (id: string) => void;
  alertsMutating: boolean;
  onNavigate: () => void;
}) {
  if ((isLoading || alertsLoading) && !data && alertRows.length === 0) {
    return (
      <div className="px-4 py-3">
        <SkeletonList rows={6} />
      </div>
    );
  }
  if (!data && alertRows.length === 0) {
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
    (data?.counts.assignedUnblocked ?? 0) +
    (data?.counts.mentions ?? 0) +
    (data?.counts.stalled ?? 0) +
    alertRows.length;

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
      {alertRows.length > 0 && (
        <MineSection
          title="Alerts"
          count={alertRows.length}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-warning" />}
        >
          {alertRows.slice(0, 6).map((row) => (
            <AlertActivityRow
              key={row.event.id}
              row={row}
              onAcknowledge={onAcknowledgeAlert}
              onDismiss={onDismissAlert}
              onResolve={onResolveAlert}
              isMutating={alertsMutating}
              onNavigate={onNavigate}
            />
          ))}
        </MineSection>
      )}

      {(data?.counts.assignedUnblocked ?? 0) > 0 && (
        <MineSection
          title="Assigned"
          count={data?.counts.assignedUnblocked ?? 0}
          icon={<UserCheck className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          {data?.assignedUnblocked.slice(0, 8).map((issue) => (
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

      {(data?.counts.mentions ?? 0) > 0 && (
        <MineSection
          title="Mentions"
          count={data?.counts.mentions ?? 0}
          icon={<AtSign className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          {data?.mentions.slice(0, 8).map((c) => {
            // Mentions are issue-scoped today; step comments don't
            // surface here yet. Skip defensively after migration 0040
            // made Comment.issueId nullable on the type.
            if (!c.issue) return null;
            const issue = c.issue;
            return (
              <MineRow
                key={c.id}
                href={`/w/${issue.workspace.slug}/issues/${issue.id}`}
                onNavigate={onNavigate}
                left={
                  <span className="font-mono text-[0.6875rem] text-muted-foreground">
                    {issue.workspace.key}-{issue.number}
                  </span>
                }
                title={issue.title}
                meta={`${c.author?.name ?? "someone"} · ${relativeTime(c.createdAt)}`}
              />
            );
          })}
        </MineSection>
      )}

      {(data?.counts.stalled ?? 0) > 0 && (
        <MineSection
          title="Stalled"
          count={data?.counts.stalled ?? 0}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />}
        >
          {data?.stalled.slice(0, 8).map((issue) => (
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
          {meta && <div className="truncate text-[0.6875rem] text-muted-foreground">{meta}</div>}
        </div>
      </Link>
    </li>
  );
}
