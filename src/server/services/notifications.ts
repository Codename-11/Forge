import "server-only";

import {
  NotificationStatus,
  type EventKind,
  type NotificationDelivery,
  type NotificationSeverity as PrismaNotificationSeverity,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  ALERTABLE_ACTIVITY_EVENT_KINDS,
  mapActivityEventToNotification,
  type EventNotificationMetadata,
} from "@/lib/notifications/event-notification";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * EventKinds the notification materializer cares about. Exported so the
 * notification router can render a checkbox row per kind on the prefs
 * page without re-encoding the list.
 */
export const ALERTABLE_EVENT_KINDS = [
  ...ALERTABLE_ACTIVITY_EVENT_KINDS,
] as EventKind[];

export const ACTIVE_NOTIFICATION_STATUSES = [
  NotificationStatus.UNREAD,
  NotificationStatus.READ,
  NotificationStatus.ACKNOWLEDGED,
] as const;

const notificationEventSelect = {
  id: true,
  workspaceId: true,
  kind: true,
  actorId: true,
  subjectType: true,
  subjectId: true,
  payload: true,
  createdAt: true,
  actor: { select: { id: true, name: true, image: true } },
} satisfies Prisma.ActivityEventSelect;

type ActivityEventForNotification = {
  id: string;
  workspaceId: string;
  kind: EventKind;
  actorId: string | null;
  subjectType: string;
  subjectId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  actor?: { id: string; name: string | null; image: string | null } | null;
};

const notificationStateArgs = {
  include: {
    event: { select: notificationEventSelect },
  },
} satisfies Prisma.NotificationStateDefaultArgs;

type NotificationStateWithEvent = Prisma.NotificationStateGetPayload<
  typeof notificationStateArgs
>;

type HydratedIssue = {
  id: string;
  number: number;
  title: string;
  workspace: { key: string };
  status: { id: string; name: string; color: string; category: string };
  project: { id: string; key: string; name: string; color: string | null } | null;
  assignedAgent: { id: string; name: string; profileKey: string } | null;
};

type HydratedAgent = {
  id: string;
  name: string;
  profileKey: string;
  avatar: string | null;
  status: "ONLINE" | "BUSY" | "OFFLINE";
};

export type NotificationEventForClient = {
  id: string;
  kind: EventKind;
  createdAt: Date;
  actor: { id: string; name: string | null; image: string | null } | null;
  subjectType: string;
  subjectId: string;
  issue: HydratedIssue | null;
  agent: HydratedAgent | null;
  payload: Prisma.JsonValue;
};

export type NotificationListItem = {
  id: string;
  status: NotificationStatus;
  severity: PrismaNotificationSeverity;
  importance: number;
  replacementKey: string | null;
  persistent: boolean;
  createdAt: Date;
  updatedAt: Date;
  readAt: Date | null;
  dismissedAt: Date | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  event: NotificationEventForClient;
  notification: EventNotificationMetadata;
};

export async function materializeRecentNotifications(
  db: DbClient,
  params: {
    workspaceId: string;
    userId: string;
    limit?: number;
    eventIds?: string[];
  },
): Promise<number> {
  const events = await findAlertableEvents(db, params);
  if (events.length === 0) return 0;

  // Load the user's effective preferences once before the per-event
  // loop so we don't issue N queries against NotificationPreference.
  // No row for a kind => enabled (default). Workspace-scoped rows
  // win over global rows for the same (user, kind).
  const prefs = await loadEffectivePreferenceMap(db, {
    userId: params.userId,
    workspaceId: params.workspaceId,
  });

  const hydrated = await hydrateNotificationEvents(db, params.workspaceId, events);
  let count = 0;
  for (const item of hydrated) {
    if (!item.metadata) continue;
    // Per-user, per-kind opt-out. The map's value is undefined when
    // the user hasn't expressed a preference — treat that as enabled.
    const pref = prefs.get(item.event.kind);
    if (pref && pref.enabled === false) continue;
    await upsertNotificationState(db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      event: item.event,
      metadata: item.metadata,
    });
    count += 1;
  }
  return count;
}

/**
 * Load the calling user's effective notification preferences as a
 * `Map<EventKind, { enabled, delivery, source }>`. A workspace-scoped
 * row wins over a global row for the same kind. Kinds with no row
 * are absent from the map — callers treat absence as "enabled".
 *
 * Pass `workspaceId: null` to ignore workspace-scoped rows entirely
 * (e.g. when rendering the global-prefs panel of the settings page).
 */
export async function loadEffectivePreferenceMap(
  db: DbClient,
  params: {
    userId: string;
    workspaceId: string | null;
  },
): Promise<
  Map<
    EventKind,
    {
      enabled: boolean;
      delivery: NotificationDelivery;
      source: "workspace" | "global";
    }
  >
> {
  const rows = await db.notificationPreference.findMany({
    where: {
      userId: params.userId,
      OR: [
        { workspaceId: null },
        ...(params.workspaceId ? [{ workspaceId: params.workspaceId }] : []),
      ],
    },
    select: {
      workspaceId: true,
      eventKind: true,
      enabled: true,
      delivery: true,
    },
  });
  const map = new Map<
    EventKind,
    {
      enabled: boolean;
      delivery: NotificationDelivery;
      source: "workspace" | "global";
    }
  >();
  // First pass: global rows. Second pass: workspace-scoped rows
  // overwrite. This guarantees workspace wins regardless of insert
  // order.
  for (const row of rows) {
    if (row.workspaceId !== null) continue;
    map.set(row.eventKind as EventKind, {
      enabled: row.enabled,
      delivery: row.delivery,
      source: "global",
    });
  }
  for (const row of rows) {
    if (row.workspaceId === null) continue;
    map.set(row.eventKind as EventKind, {
      enabled: row.enabled,
      delivery: row.delivery,
      source: "workspace",
    });
  }
  return map;
}

export async function buildNotificationListItems(
  db: DbClient,
  workspaceId: string,
  states: NotificationStateWithEvent[],
): Promise<NotificationListItem[]> {
  if (states.length === 0) return [];

  const hydrated = await hydrateNotificationEvents(
    db,
    workspaceId,
    states.map((s) => s.event),
  );
  const byEventId = new Map(hydrated.map((item) => [item.event.id, item]));

  return states
    .map((state) => {
      const hydratedEvent = byEventId.get(state.eventId);
      if (!hydratedEvent) return null;
      const metadata = mergeStateMetadata(state, hydratedEvent.metadata);
      if (!metadata) return null;
      return {
        id: state.id,
        status: state.status,
        severity: state.severity,
        importance: state.importance,
        replacementKey: state.replacementKey,
        persistent: state.persistent,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        readAt: state.readAt,
        dismissedAt: state.dismissedAt,
        acknowledgedAt: state.acknowledgedAt,
        resolvedAt: state.resolvedAt,
        event: hydratedEvent.event,
        notification: metadata,
      } satisfies NotificationListItem;
    })
    .filter((item): item is NotificationListItem => item !== null);
}

export function notificationStateInclude() {
  return notificationStateArgs.include;
}

async function findAlertableEvents(
  db: DbClient,
  params: {
    workspaceId: string;
    limit?: number;
    eventIds?: string[];
  },
): Promise<ActivityEventForNotification[]> {
  if (params.eventIds?.length) {
    return db.activityEvent.findMany({
      where: {
        workspaceId: params.workspaceId,
        id: { in: params.eventIds },
        kind: { in: ALERTABLE_EVENT_KINDS },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: notificationEventSelect,
    });
  }

  const rows = await db.activityEvent.findMany({
    where: {
      workspaceId: params.workspaceId,
      kind: { in: ALERTABLE_EVENT_KINDS },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: params.limit ?? 100,
    select: notificationEventSelect,
  });
  return rows.reverse();
}

async function hydrateNotificationEvents(
  db: DbClient,
  workspaceId: string,
  events: ActivityEventForNotification[],
): Promise<
  Array<{
    event: NotificationEventForClient;
    metadata: EventNotificationMetadata | null;
  }>
> {
  if (events.length === 0) return [];

  const workspace = await db.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { slug: true, key: true },
  });

  const issueIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const event of events) {
    if (event.subjectType === "issue") issueIds.add(event.subjectId);
    if (event.subjectType === "agent") agentIds.add(event.subjectId);
    const payload = asPayload(event.payload);
    const agentId = readPayloadString(payload, "agentId");
    const assignedAgentId = readPayloadString(payload, "assignedAgentId");
    if (agentId) agentIds.add(agentId);
    if (assignedAgentId) agentIds.add(assignedAgentId);
  }

  const [issues, agents] = await Promise.all([
    issueIds.size
      ? db.issue.findMany({
          where: {
            id: { in: Array.from(issueIds) },
            workspaceId,
          },
          select: {
            id: true,
            number: true,
            title: true,
            workspace: { select: { key: true } },
            status: {
              select: { id: true, name: true, color: true, category: true },
            },
            project: { select: { id: true, key: true, name: true, color: true } },
            assignedAgent: {
              select: { id: true, name: true, profileKey: true },
            },
          },
        })
      : Promise.resolve([]),
    agentIds.size
      ? db.agent.findMany({
          where: {
            id: { in: Array.from(agentIds) },
            workspaceId,
          },
          select: {
            id: true,
            name: true,
            profileKey: true,
            avatar: true,
            status: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  return events.map((event) => {
    const payload = asPayload(event.payload);
    const payloadAgentId =
      readPayloadString(payload, "agentId") ??
      readPayloadString(payload, "assignedAgentId");
    const issue =
      event.subjectType === "issue"
        ? ((issueById.get(event.subjectId) as HydratedIssue | undefined) ?? null)
        : null;
    const subjectAgent =
      event.subjectType === "agent"
        ? ((agentById.get(event.subjectId) as HydratedAgent | undefined) ?? null)
        : null;
    const payloadAgent = payloadAgentId
      ? ((agentById.get(payloadAgentId) as HydratedAgent | undefined) ?? null)
      : null;
    const agent = subjectAgent ?? payloadAgent;
    const clientEvent = {
      id: event.id,
      kind: event.kind,
      createdAt: event.createdAt,
      actor: event.actor ?? null,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      issue,
      agent,
      payload: event.payload,
    } satisfies NotificationEventForClient;
    return {
      event: clientEvent,
      metadata: mapActivityEventToNotification({
        workspace,
        event: {
          id: event.id,
          kind: event.kind,
          subjectType: event.subjectType,
          subjectId: event.subjectId,
          payload: event.payload,
        },
        issue,
        agent,
      }),
    };
  });
}

async function upsertNotificationState(
  db: DbClient,
  params: {
    workspaceId: string;
    userId: string;
    event: NotificationEventForClient;
    metadata: EventNotificationMetadata;
  },
) {
  const { workspaceId, userId, event, metadata } = params;
  const now = new Date();
  const replacementKey = metadata.replacementKey;
  const newerReplacement = replacementKey
    ? await db.notificationState.findFirst({
        where: {
          workspaceId,
          userId,
          replacementKey,
          event: { createdAt: { gt: event.createdAt } },
        },
        select: { id: true },
      })
    : null;
  const createResolved = Boolean(newerReplacement);

  const state = await db.notificationState.upsert({
    where: {
      workspaceId_userId_eventId: {
        workspaceId,
        userId,
        eventId: event.id,
      },
    },
    create: {
      workspaceId,
      userId,
      eventId: event.id,
      replacementKey,
      severity: metadata.severity,
      importance: metadata.importance,
      status: createResolved
        ? NotificationStatus.RESOLVED
        : NotificationStatus.UNREAD,
      persistent: metadata.persistent,
      primaryHref: metadata.primaryHref,
      detailHref: metadata.detailHref,
      summary: metadata.summary,
      reason: metadata.reason,
      recommendedAction: metadata.recommendedAction,
      createdAt: event.createdAt,
      readAt: createResolved ? now : undefined,
      resolvedAt: createResolved ? now : undefined,
    },
    update: {
      replacementKey,
      severity: metadata.severity,
      importance: metadata.importance,
      persistent: metadata.persistent,
      primaryHref: metadata.primaryHref,
      detailHref: metadata.detailHref,
      summary: metadata.summary,
      reason: metadata.reason,
      recommendedAction: metadata.recommendedAction,
    },
  });

  if (replacementKey) {
    await db.notificationState.updateMany({
      where: {
        workspaceId,
        userId,
        replacementKey,
        eventId: { not: event.id },
        status: { in: [...ACTIVE_NOTIFICATION_STATUSES] },
        event: { createdAt: { lte: event.createdAt } },
      },
      data: {
        status: NotificationStatus.RESOLVED,
        readAt: now,
        resolvedAt: now,
      },
    });
  }

  return state;
}

function mergeStateMetadata(
  state: NotificationStateWithEvent,
  mapped: EventNotificationMetadata | null,
): EventNotificationMetadata | null {
  if (!mapped) return null;

  const primaryHref = state.primaryHref ?? mapped.primaryHref;
  const detailHref = state.detailHref ?? undefined;
  const primaryActionLabel = actionLabelForHref(
    primaryHref,
    mapped.primaryActionLabel,
  );
  const detailActionLabel = detailHref
    ? actionLabelForHref(detailHref, mapped.detailActionLabel ?? "Open details")
    : undefined;

  return {
    ...mapped,
    severity: state.severity,
    importance: state.importance,
    persistent: state.persistent,
    summary: state.summary,
    reason: state.reason ?? undefined,
    recommendedAction: state.recommendedAction ?? mapped.recommendedAction,
    primaryHref,
    detailHref,
    primaryActionLabel,
    detailActionLabel,
    replacementKey: state.replacementKey ?? mapped.replacementKey,
    toast: {
      ...mapped.toast,
      title: state.summary,
      description: state.reason ?? mapped.toast.description,
      actionLabel: primaryActionLabel,
    },
  };
}

function actionLabelForHref(href: string, fallback: string): string {
  if (href.includes("/agents/") && href.includes("health=")) {
    return "Check health";
  }
  if (href.includes("/issues/") && href.includes("tab=activity")) {
    return "Open activity";
  }
  if (href.includes("/issues/")) return "View issue";
  if (href.includes("/agents/")) return "View agent";
  return fallback;
}

function asPayload(payload: Prisma.JsonValue): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
