import "server-only";

import {
  EventKind,
  NotificationStatus,
  type NotificationDelivery,
  type NotificationSeverity as PrismaNotificationSeverity,
  type NotificationState,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  ALERTABLE_ACTIVITY_EVENT_KINDS,
  mapActivityEventToNotification,
  type EventNotificationMetadata,
} from "@/lib/notifications/event-notification";
import { logger } from "@/server/logger";
import { sendBrowserPushToUser, type BrowserPushPayload } from "@/server/services/web-push";
import { filterProjectDerivedRecords } from "@/server/services/derived-project-access";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * EventKinds the notification materializer cares about. Exported so the
 * notification router can render a checkbox row per kind on the prefs
 * page without re-encoding the list.
 */
export const ALERTABLE_EVENT_KINDS = [...ALERTABLE_ACTIVITY_EVENT_KINDS] as EventKind[];

export const ACTIVE_NOTIFICATION_STATUSES = [
  NotificationStatus.UNREAD,
  NotificationStatus.READ,
  NotificationStatus.ACKNOWLEDGED,
] as const;

function payloadString(payload: Prisma.JsonValue, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Prisma.JsonObject)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Keep the mutable alert lifecycle aligned with the subject that produced it.
 * NotificationState is the shared alert/notification record; surfaces should
 * not each invent their own stale-open interpretation. This reconciler closes
 * alerts when durable product state proves the condition recovered.
 */
export async function reconcileRecoveredNotifications(
  db: DbClient,
  params: { workspaceId: string; userId: string; limit?: number },
): Promise<number> {
  const rows = await db.notificationState.findMany({
    where: {
      workspaceId: params.workspaceId,
      userId: params.userId,
      status: { in: [...ACTIVE_NOTIFICATION_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(params.limit ?? 100, 1), 250),
    select: {
      id: true,
      event: {
        select: {
          kind: true,
          subjectType: true,
          subjectId: true,
          payload: true,
          createdAt: true,
        },
      },
    },
  });

  const issueAlerts = rows.filter(
    (row) =>
      row.event.kind === EventKind.ISSUE_STALLED || row.event.kind === EventKind.ISSUE_SLA_BREACH,
  );
  const issueIds = [
    ...new Set(
      issueAlerts.map((row) => payloadString(row.event.payload, "issueId") ?? row.event.subjectId),
    ),
  ];
  const runIds = [
    ...new Set(
      rows.flatMap((row) => {
        if (row.event.kind === EventKind.AGENT_NOACK) {
          const runId = payloadString(row.event.payload, "runId");
          return runId ? [runId] : [];
        }
        if (row.event.kind === EventKind.AGENT_RUN_STALLED) {
          return [payloadString(row.event.payload, "runId") ?? row.event.subjectId];
        }
        return [];
      }),
    ),
  ];
  const planIds = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.event.kind === EventKind.PLAN_BUDGET_EXCEEDED ||
            row.event.kind === EventKind.PLAN_STALLED,
        )
        .map((row) => row.event.subjectId),
    ),
  ];
  const stepIds = [
    ...new Set(
      rows
        .filter((row) => row.event.kind === EventKind.EXECUTION_STEP_JUDGED)
        .map((row) => row.event.subjectId),
    ),
  ];
  const earliestIssueAlert = issueAlerts.reduce<Date | null>(
    (earliest, row) =>
      !earliest || row.event.createdAt < earliest ? row.event.createdAt : earliest,
    null,
  );

  // Batch recovery evidence by entity class. This runs whenever the bell
  // count refreshes, so an N+1 query per active alert would become costly for
  // noisy workspaces.
  const [issues, issueMovements, runs, plans, steps] = await Promise.all([
    db.issue.findMany({
      where: { id: { in: issueIds }, workspaceId: params.workspaceId },
      select: { id: true, deletedAt: true, status: { select: { category: true } } },
    }),
    db.activityEvent.findMany({
      where: {
        workspaceId: params.workspaceId,
        subjectType: "issue",
        subjectId: { in: issueIds },
        ...(earliestIssueAlert ? { createdAt: { gt: earliestIssueAlert } } : {}),
        OR: [
          {
            kind: {
              in: [
                EventKind.ISSUE_STATUS_CHANGED,
                EventKind.ISSUE_ASSIGNED,
                EventKind.AGENT_ASSIGNED,
              ],
            },
          },
          { kind: EventKind.COMMENT_CREATED, actorAgentId: { not: null } },
        ],
      },
      select: { subjectId: true, kind: true, actorAgentId: true, createdAt: true },
    }),
    db.agentRun.findMany({
      where: { id: { in: runIds }, workspaceId: params.workspaceId },
      select: {
        id: true,
        status: true,
        acknowledgedAt: true,
        outputStartedAt: true,
        clearedAt: true,
        supersededByRunId: true,
      },
    }),
    db.executionPlan.findMany({
      where: { id: { in: planIds }, workspaceId: params.workspaceId },
      select: { id: true, status: true, updatedAt: true, archivedAt: true },
    }),
    db.executionStep.findMany({
      where: { id: { in: stepIds }, workspaceId: params.workspaceId },
      select: { id: true, status: true },
    }),
  ]);
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const runById = new Map(runs.map((run) => [run.id, run]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const stepById = new Map(steps.map((step) => [step.id, step]));

  const recovered = rows.flatMap((row) => {
    const event = row.event;
    if (event.kind === EventKind.ISSUE_STALLED || event.kind === EventKind.ISSUE_SLA_BREACH) {
      const issueId = payloadString(event.payload, "issueId") ?? event.subjectId;
      const issue = issueById.get(issueId);
      if (!issue || issue.deletedAt) return [row.id];
      if (["IN_REVIEW", "DONE", "CANCELED"].includes(issue.status.category)) return [row.id];
      const assignedAgentId = payloadString(event.payload, "assignedAgentId");
      const moved = issueMovements.some(
        (movement) =>
          movement.subjectId === issueId &&
          movement.createdAt > event.createdAt &&
          (movement.kind !== EventKind.COMMENT_CREATED ||
            (movement.actorAgentId &&
              (!assignedAgentId || movement.actorAgentId === assignedAgentId))),
      );
      return moved ? [row.id] : [];
    }

    if (event.kind === EventKind.AGENT_NOACK) {
      const runId = payloadString(event.payload, "runId");
      if (!runId) return [];
      const run = runById.get(runId);
      return !run || run.acknowledgedAt || run.outputStartedAt || run.status !== "ACTIVE"
        ? [row.id]
        : [];
    }

    if (event.kind === EventKind.AGENT_RUN_STALLED) {
      const runId = payloadString(event.payload, "runId") ?? event.subjectId;
      const run = runById.get(runId);
      return !run || run.clearedAt || run.supersededByRunId || run.status === "COMPLETED"
        ? [row.id]
        : [];
    }

    if (event.kind === EventKind.PLAN_BUDGET_EXCEEDED || event.kind === EventKind.PLAN_STALLED) {
      const plan = planById.get(event.subjectId);
      if (!plan || plan.archivedAt) return [row.id];
      if (event.kind === EventKind.PLAN_BUDGET_EXCEEDED) {
        return plan.status !== "BLOCKED" ? [row.id] : [];
      }
      return plan.updatedAt > event.createdAt && !["RUNNING", "BLOCKED"].includes(plan.status)
        ? [row.id]
        : [];
    }

    if (event.kind === EventKind.EXECUTION_STEP_JUDGED) {
      const step = stepById.get(event.subjectId);
      return !step || step.status !== "BLOCKED" ? [row.id] : [];
    }

    return [];
  });

  if (recovered.length === 0) return 0;
  const now = new Date();
  const result = await db.notificationState.updateMany({
    where: {
      id: { in: recovered },
      workspaceId: params.workspaceId,
      userId: params.userId,
      status: { in: [...ACTIVE_NOTIFICATION_STATUSES] },
    },
    data: { status: NotificationStatus.RESOLVED, readAt: now, resolvedAt: now },
  });
  return result.count;
}

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

const NOTIFICATION_FANOUT_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

type NotificationStateWithEvent = Prisma.NotificationStateGetPayload<typeof notificationStateArgs>;

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
    push?: boolean;
  },
): Promise<number> {
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: params.userId, workspaceId: params.workspaceId } },
    select: { id: true, role: true },
  });
  if (!membership) return 0;
  const events = await filterProjectDerivedRecords(
    db,
    { workspaceId: params.workspaceId, membership },
    await findAlertableEvents(db, params),
  );
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
    const result = await upsertNotificationState(db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      event: item.event,
      metadata: item.metadata,
    });
    if (
      params.push === true &&
      result.created &&
      result.state.status === NotificationStatus.UNREAD
    ) {
      await sendBrowserPushToUser(
        db,
        params.userId,
        buildBrowserPushPayload(result.state, item.metadata),
      );
    }
    count += 1;
  }
  return count;
}

export async function materializeEventNotificationsForWorkspace(
  db: DbClient,
  params: {
    workspaceId: string;
    eventId: string;
  },
): Promise<number> {
  const event = await db.activityEvent.findFirst({
    where: {
      id: params.eventId,
      workspaceId: params.workspaceId,
      kind: { in: ALERTABLE_EVENT_KINDS },
    },
    select: { actorId: true },
  });
  if (!event) return 0;

  const memberships = await db.membership.findMany({
    where: { workspaceId: params.workspaceId },
    select: { userId: true },
  });

  let count = 0;
  for (const membership of memberships) {
    if (event.actorId && membership.userId === event.actorId) continue;
    count += await materializeRecentNotifications(db, {
      workspaceId: params.workspaceId,
      userId: membership.userId,
      eventIds: [params.eventId],
      push: true,
    });
  }
  return count;
}

export function scheduleEventNotificationFanout(
  db: PrismaClient,
  params: {
    workspaceId: string;
    eventId: string;
  },
): void {
  scheduleEventNotificationFanoutAttempt(db, params, 0, 0);
}

function scheduleEventNotificationFanoutAttempt(
  db: PrismaClient,
  params: {
    workspaceId: string;
    eventId: string;
  },
  attempt: number,
  delayMs: number,
) {
  setTimeout(() => {
    void runScheduledEventNotificationFanout(db, params, attempt).catch((err) => {
      logger.warn({ err, eventId: params.eventId }, "notification push fan-out failed");
    });
  }, delayMs);
}

async function runScheduledEventNotificationFanout(
  db: PrismaClient,
  params: {
    workspaceId: string;
    eventId: string;
  },
  attempt: number,
): Promise<void> {
  const event = await db.activityEvent.findFirst({
    where: {
      id: params.eventId,
      workspaceId: params.workspaceId,
      kind: { in: ALERTABLE_EVENT_KINDS },
    },
    select: { id: true },
  });
  if (!event) {
    const retryDelay = NOTIFICATION_FANOUT_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined) {
      scheduleEventNotificationFanoutAttempt(db, params, attempt + 1, retryDelay);
    }
    return;
  }

  await materializeEventNotificationsForWorkspace(db, params);
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

  const membership = await db.membership.findUnique({
    where: {
      userId_workspaceId: {
        userId: states[0].userId,
        workspaceId,
      },
    },
    select: { id: true, role: true },
  });
  if (!membership) return [];
  const visibleStates = await filterProjectDerivedRecords(
    db,
    { workspaceId, membership },
    states.map((state) => ({
      ...state,
      subjectType: state.event.subjectType,
      subjectId: state.event.subjectId,
      payload: state.event.payload,
    })),
  );
  const hydrated = await hydrateNotificationEvents(
    db,
    workspaceId,
    visibleStates.map((s) => s.event),
  );
  const byEventId = new Map(hydrated.map((item) => [item.event.id, item]));

  return visibleStates
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
    const issueId = readPayloadString(payload, "issueId");
    const agentId = readPayloadString(payload, "agentId");
    const assignedAgentId = readPayloadString(payload, "assignedAgentId");
    if (issueId) issueIds.add(issueId);
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
      readPayloadString(payload, "agentId") ?? readPayloadString(payload, "assignedAgentId");
    const issue =
      event.subjectType === "issue"
        ? ((issueById.get(event.subjectId) as HydratedIssue | undefined) ?? null)
        : readPayloadString(payload, "issueId")
          ? ((issueById.get(readPayloadString(payload, "issueId")!) as HydratedIssue | undefined) ??
            null)
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
): Promise<{
  state: NotificationState;
  created: boolean;
}> {
  const { workspaceId, userId, event, metadata } = params;
  const now = new Date();
  const replacementKey = metadata.replacementKey;
  const existingState = await db.notificationState.findUnique({
    where: {
      workspaceId_userId_eventId: {
        workspaceId,
        userId,
        eventId: event.id,
      },
    },
    select: { id: true },
  });
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
      status: createResolved ? NotificationStatus.RESOLVED : NotificationStatus.UNREAD,
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

  return { state, created: !existingState };
}

function buildBrowserPushPayload(
  state: NotificationState,
  metadata: EventNotificationMetadata,
): BrowserPushPayload {
  const body =
    metadata.toast.description ?? state.reason ?? metadata.reason ?? metadata.recommendedAction;
  return {
    title: metadata.toast.title,
    body: body ? truncatePushBody(body) : undefined,
    url: metadata.primaryHref,
    tag: metadata.replacementKey,
    notificationId: state.id,
    icon: "/icons/forge-icon-192.png",
    badge: "/icons/forge-icon-192.png",
    renotify: metadata.severity === "ERROR" || metadata.severity === "CRITICAL",
    requireInteraction: metadata.importance >= 80,
  };
}

function truncatePushBody(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function mergeStateMetadata(
  state: NotificationStateWithEvent,
  mapped: EventNotificationMetadata | null,
): EventNotificationMetadata | null {
  if (!mapped) return null;

  const primaryHref = state.primaryHref ?? mapped.primaryHref;
  const detailHref = state.detailHref ?? undefined;
  const primaryActionLabel = actionLabelForHref(primaryHref, mapped.primaryActionLabel);
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
