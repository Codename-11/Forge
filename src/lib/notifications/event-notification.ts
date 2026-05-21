export const ALERTABLE_ACTIVITY_EVENT_KINDS = [
  "AGENT_NOACK",
  "ISSUE_SLA_BREACH",
  "ISSUE_STALLED",
  // Orchestration — transient "this happened" alerts. Persistent
  // "needs your decision" state (plan approvals, open review gates) is
  // counted directly off the ActionRequest / ReviewGate tables via the
  // Decisions badge rather than materialized here.
  "GOAL_STATUS_CHANGED",
  "PLAN_BUDGET_EXCEEDED",
  "EXECUTION_STEP_JUDGED",
] as const;

export type AlertableActivityEventKind = (typeof ALERTABLE_ACTIVITY_EVENT_KINDS)[number];

export type NotificationSeverity = "INFO" | "SUCCESS" | "WARNING" | "ERROR" | "CRITICAL";

export type NotificationWorkspaceContext = {
  slug: string;
  key?: string | null;
};

export type NotificationAgentReference = {
  id?: string | null;
  name?: string | null;
  profileKey?: string | null;
};

export type NotificationIssueReference = {
  id: string;
  number?: number | null;
  title?: string | null;
  workspace?: { key?: string | null } | null;
  assignedAgent?: NotificationAgentReference | null;
};

export type NotificationActivityEvent<K extends string = AlertableActivityEventKind> = {
  id?: string | null;
  kind: K;
  subjectType: string;
  subjectId: string;
  payload?: unknown;
};

export type EventNotificationInput<K extends string = AlertableActivityEventKind> = {
  event: NotificationActivityEvent<K>;
  workspace: NotificationWorkspaceContext;
  issue?: NotificationIssueReference | null;
  agent?: NotificationAgentReference | null;
};

export type EventNotificationMetadata = {
  kind: AlertableActivityEventKind;
  severity: NotificationSeverity;
  importance: number;
  persistent: boolean;
  summary: string;
  reason?: string;
  recommendedAction: string;
  primaryHref: string;
  detailHref?: string;
  primaryActionLabel: string;
  detailActionLabel?: string;
  replacementKey: string;
  toast: {
    title: string;
    description?: string;
    actionLabel: string;
  };
};

export type EventNotificationActionLink = {
  href: string;
  label: string;
  kind: "primary" | "detail";
};

const ALERTABLE_KIND_SET = new Set<AlertableActivityEventKind>(ALERTABLE_ACTIVITY_EVENT_KINDS);

export function isAlertableActivityEventKind(kind: string): kind is AlertableActivityEventKind {
  return ALERTABLE_KIND_SET.has(kind as AlertableActivityEventKind);
}

export function mapActivityEventToNotification(
  input: EventNotificationInput<string>,
): EventNotificationMetadata | null {
  if (!isAlertableActivityEventKind(input.event.kind)) return null;
  return mapAlertableActivityEventToNotification(
    input as EventNotificationInput<AlertableActivityEventKind>,
  );
}

export function mapAlertableActivityEventToNotification(
  input: EventNotificationInput<AlertableActivityEventKind>,
): EventNotificationMetadata | null {
  const payload = asPayload(input.event.payload);
  const issueLabel = buildIssueLabel(input.workspace, input.issue, payload);
  const issueId =
    input.issue?.id ?? (input.event.subjectType === "issue" ? input.event.subjectId : null);
  const issueHref = issueId ? buildIssueHref(input.workspace, issueId) : undefined;
  const issueActivityHref = issueHref ? `${issueHref}?tab=activity` : undefined;
  const agentProfileKey = resolveAgentProfileKey(
    input.agent ?? input.issue?.assignedAgent,
    payload,
  );
  const agentHref = agentProfileKey ? buildAgentHref(input.workspace, agentProfileKey) : undefined;
  const agentHealthHref = agentHref ? `${agentHref}?health=noack#dispatch-health` : undefined;
  const primaryIssueHref = issueHref ?? buildWorkspaceHref(input.workspace);

  switch (input.event.kind) {
    case "AGENT_NOACK": {
      const requiredAckSeconds = readPayloadNumber(payload, "requiredAckSeconds");
      const agentLabel = agentProfileKey ? `@${agentProfileKey}` : "The assigned agent";
      const reason =
        requiredAckSeconds != null
          ? `${agentLabel} did not acknowledge ${issueLabel} within ${formatSeconds(requiredAckSeconds)}.`
          : `${agentLabel} did not acknowledge ${issueLabel}.`;
      const description = agentProfileKey
        ? `${agentLabel} did not ack${
            requiredAckSeconds != null ? ` within ${formatSeconds(requiredAckSeconds)}` : ""
          }`
          : requiredAckSeconds != null
          ? `No ack within ${formatSeconds(requiredAckSeconds)}`
          : undefined;
      const primaryHref = issueHref ?? agentHref ?? buildWorkspaceHref(input.workspace);
      const detailHref = agentHealthHref ?? issueActivityHref;
      const primaryActionLabel = issueHref
        ? "View issue"
        : agentHealthHref
          ? "View agent"
          : "Open workspace";
      const detailActionLabel = agentHref
        ? "Check health"
        : issueActivityHref
          ? "Open activity"
          : undefined;
      return {
        kind: input.event.kind,
        severity: "WARNING",
        importance: 70,
        persistent: true,
        summary: agentProfileKey
          ? `${agentLabel} missed wake for ${issueLabel}`
          : `Missed wake for ${issueLabel}`,
        reason,
        recommendedAction:
          "Check the agent heartbeat and webhook delivery, then reassign or retry dispatch if needed.",
        primaryHref,
        detailHref,
        primaryActionLabel,
        detailActionLabel,
        replacementKey: [
          "agent",
          agentProfileKey ?? readPayloadString(payload, "agentId") ?? input.agent?.id ?? "unknown",
          "noack",
          issueId ?? input.event.id ?? "unknown",
        ].join(":"),
        toast: {
          title: `Missed wake: ${issueLabel}`,
          description,
          actionLabel: primaryActionLabel,
        },
      };
    }
    case "ISSUE_SLA_BREACH": {
      const slaMinutes = readPayloadNumber(payload, "slaMinutes");
      const breachedByMinutes = readPayloadNumber(payload, "breachedByMinutes");
      const primaryActionLabel = issueHref ? "View issue" : "Open workspace";
      const reason =
        breachedByMinutes != null && slaMinutes != null
          ? `${issueLabel} is ${formatMinutes(breachedByMinutes)} overdue against a ${formatMinutes(slaMinutes)} SLA.`
          : breachedByMinutes != null
            ? `${issueLabel} is ${formatMinutes(breachedByMinutes)} overdue.`
            : slaMinutes != null
              ? `${issueLabel} passed its ${formatMinutes(slaMinutes)} SLA.`
              : `${issueLabel} passed its SLA target.`;
      return {
        kind: input.event.kind,
        severity: "ERROR",
        importance: 85,
        persistent: true,
        summary: `${issueLabel} breached SLA`,
        reason,
        recommendedAction:
          "Reprioritize the issue, assign a clear owner, or escalate the blocked work.",
        primaryHref: primaryIssueHref,
        detailHref: issueActivityHref,
        primaryActionLabel,
        detailActionLabel: issueActivityHref ? "Open activity" : undefined,
        replacementKey: `issue:${issueId ?? input.event.id ?? "unknown"}:sla-breach`,
        toast: {
          title: `SLA breach: ${issueLabel}`,
          description:
            breachedByMinutes != null ? `${formatMinutes(breachedByMinutes)} overdue` : undefined,
          actionLabel: primaryActionLabel,
        },
      };
    }
    case "GOAL_STATUS_CHANGED": {
      // Only the terminal transitions are worth a nudge — routine
      // OPEN→PLANNING→ACTIVE churn would be noise. Return null otherwise
      // so the materializer drops it.
      const to = readPayloadString(payload, "to");
      const goalHref = buildGoalHref(input.workspace, input.event.subjectId);
      if (to === "ACHIEVED") {
        return {
          kind: input.event.kind,
          severity: "SUCCESS",
          importance: 55,
          persistent: false,
          summary: "Goal achieved",
          reason: "An orchestration goal reached its objective — every step passed review.",
          recommendedAction: "Review the result and close out any follow-on work.",
          primaryHref: goalHref,
          primaryActionLabel: "View goal",
          replacementKey: `goal:${input.event.subjectId}:status`,
          toast: { title: "Goal achieved", actionLabel: "View goal" },
        };
      }
      if (to === "ABANDONED") {
        return {
          kind: input.event.kind,
          severity: "WARNING",
          importance: 60,
          persistent: true,
          summary: "Goal abandoned",
          reason: "An orchestration goal was abandoned before reaching its objective.",
          recommendedAction: "Open the goal to see how far it got and decide whether to retry.",
          primaryHref: goalHref,
          primaryActionLabel: "View goal",
          replacementKey: `goal:${input.event.subjectId}:status`,
          toast: { title: "Goal abandoned", actionLabel: "View goal" },
        };
      }
      return null;
    }
    case "PLAN_BUDGET_EXCEEDED": {
      const reasonText = readPayloadString(payload, "reason");
      const planHref = buildPlanHref(input.workspace, input.event.subjectId);
      return {
        kind: input.event.kind,
        severity: "WARNING",
        importance: 80,
        persistent: true,
        summary: "Plan paused — budget exceeded",
        reason: reasonText
          ? `A plan hit its cap (${reasonText}) and is blocked pending your decision.`
          : "A plan exceeded its budget/time cap and is blocked pending your decision.",
        recommendedAction: "Open the plan to approve continuation (raise the cap) or abandon it.",
        primaryHref: planHref,
        primaryActionLabel: "Open plan",
        replacementKey: `plan:${input.event.subjectId}:budget`,
        toast: {
          title: "Plan paused — budget exceeded",
          description: reasonText ?? undefined,
          actionLabel: "Open plan",
        },
      };
    }
    case "EXECUTION_STEP_JUDGED": {
      // Only a BLOCKED outcome (retries exhausted) needs a nudge; PASS
      // and retryable FAIL are routine loop progress.
      const outcome = readPayloadString(payload, "outcome");
      if (outcome !== "BLOCKED") return null;
      const planId = readPayloadString(payload, "planId");
      const feedback = readPayloadString(payload, "feedback");
      const planHref = planId
        ? buildPlanHref(input.workspace, planId)
        : buildWorkspaceHref(input.workspace);
      return {
        kind: input.event.kind,
        severity: "ERROR",
        importance: 82,
        persistent: true,
        summary: "Plan step blocked",
        reason: feedback
          ? `A step failed review and exhausted its retries: ${feedback}`
          : "A step failed review and exhausted its retries — the plan is blocked.",
        recommendedAction: "Open the plan, resolve the review gate, or revise and retry the step.",
        primaryHref: planHref,
        primaryActionLabel: "Open plan",
        replacementKey: `step:${input.event.subjectId}:blocked`,
        toast: {
          title: "Plan step blocked",
          description: feedback ?? undefined,
          actionLabel: "Open plan",
        },
      };
    }
    case "ISSUE_STALLED": {
      const slaMinutes = readPayloadNumber(payload, "slaMinutes");
      const agentLabel = agentProfileKey ? `@${agentProfileKey}` : null;
      const primaryActionLabel = issueHref ? "View issue" : "Open workspace";
      const reasonParts = [
        `${issueLabel} has not moved`,
        slaMinutes != null ? `within its ${formatMinutes(slaMinutes)} assignment SLA` : null,
        agentLabel ? `while assigned to ${agentLabel}` : null,
      ].filter(Boolean);
      return {
        kind: input.event.kind,
        severity: "WARNING",
        importance: 65,
        persistent: true,
        summary: `${issueLabel} stalled`,
        reason: `${reasonParts.join(" ")}.`,
        recommendedAction:
          "Check the latest status, comment, and assignee before deciding whether to reassign.",
        primaryHref: primaryIssueHref,
        detailHref: issueActivityHref,
        primaryActionLabel,
        detailActionLabel: issueActivityHref ? "Open activity" : undefined,
        replacementKey: `issue:${issueId ?? input.event.id ?? "unknown"}:stalled`,
        toast: {
          title: `Stalled: ${issueLabel} has not moved`,
          description: agentLabel
            ? `Assigned ${agentLabel}${
                slaMinutes != null ? ` - ${formatMinutes(slaMinutes)} SLA` : ""
              }`
            : slaMinutes != null
              ? `${formatMinutes(slaMinutes)} assignment SLA`
              : undefined,
          actionLabel: primaryActionLabel,
        },
      };
    }
  }
}

export function getEventNotificationActionLinks(
  notification: EventNotificationMetadata,
): EventNotificationActionLink[] {
  const links: EventNotificationActionLink[] = [
    {
      href: notification.primaryHref,
      label: notification.primaryActionLabel,
      kind: "primary",
    },
  ];

  if (
    notification.detailHref &&
    notification.detailHref !== notification.primaryHref
  ) {
    links.push({
      href: notification.detailHref,
      label: notification.detailActionLabel ?? "Open details",
      kind: "detail",
    });
  }

  return links;
}

export function buildWorkspaceHref(workspace: NotificationWorkspaceContext): string {
  return `/w/${encodeURIComponent(workspace.slug)}`;
}

export function buildIssueHref(workspace: NotificationWorkspaceContext, issueId: string): string {
  return `${buildWorkspaceHref(workspace)}/issues/${encodeURIComponent(issueId)}`;
}

export function buildAgentHref(
  workspace: NotificationWorkspaceContext,
  profileKey: string,
): string {
  return `${buildWorkspaceHref(workspace)}/agents/${encodeURIComponent(profileKey)}`;
}

export function buildGoalHref(
  workspace: NotificationWorkspaceContext,
  goalId: string,
): string {
  return `${buildWorkspaceHref(workspace)}/goals/${encodeURIComponent(goalId)}`;
}

export function buildPlanHref(
  workspace: NotificationWorkspaceContext,
  planId: string,
): string {
  return `${buildWorkspaceHref(workspace)}/plans/${encodeURIComponent(planId)}`;
}

function asPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readPayloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveAgentProfileKey(
  agent: NotificationAgentReference | null | undefined,
  payload: Record<string, unknown>,
): string | null {
  const fromAgent = agent?.profileKey?.trim();
  if (fromAgent) return fromAgent;
  return readPayloadString(payload, "agentProfileKey");
}

function buildIssueLabel(
  workspace: NotificationWorkspaceContext,
  issue: NotificationIssueReference | null | undefined,
  payload: Record<string, unknown>,
): string {
  const issuePrefix = readPayloadString(payload, "issuePrefix");
  if (issuePrefix) return issuePrefix;
  const key = issue?.workspace?.key ?? workspace.key ?? null;
  if (key && typeof issue?.number === "number") return `${key}-${issue.number}`;
  const payloadNumber = readPayloadNumber(payload, "number");
  if (key && payloadNumber != null) return `${key}-${Math.trunc(payloadNumber)}`;
  return "an issue";
}

function formatMinutes(value: number): string {
  return `${Math.max(0, Math.round(value))}m`;
}

function formatSeconds(value: number): string {
  return `${Math.max(0, Math.round(value))}s`;
}
