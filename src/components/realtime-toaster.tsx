"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UserCheck,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  MessageCircle,
  Target,
  Wallet,
} from "lucide-react";
import { useRealtime } from "@/hooks/use-realtime";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import {
  mapActivityEventToNotification,
  type EventNotificationMetadata,
} from "@/lib/notifications/event-notification";

type DispatchPayload = {
  mode?: string;
  reason?: string;
  chosen?: { name?: string; profileKey?: string } | null;
};

type EventPayload = {
  dispatch?: DispatchPayload | null;
  profileKey?: string;
  to?: string;
  from?: string;
  mentionsCount?: number;
  actorName?: string;
  issuePrefix?: string;
  agentProfileKey?: string;
  engagementMode?: string;
  via?: string;
  agentRequests?: Array<{ profileKey?: string; mode?: string }>;
  slaMinutes?: number;
  requiredAckSeconds?: number;
  breachedByMinutes?: number;
};

function asPayload(p: unknown): EventPayload {
  if (!p || typeof p !== "object") return {};
  return p as EventPayload;
}

const RECENT_LIMIT = 100;

function toastDurationFor(notification: EventNotificationMetadata): number {
  return notification.severity === "ERROR" || notification.severity === "CRITICAL" ? 12_000 : 8_000;
}

function iconForNotification(notification: EventNotificationMetadata) {
  switch (notification.kind) {
    case "ISSUE_SLA_BREACH":
      return <Clock className="h-4 w-4" />;
    case "AGENT_NOACK":
    case "ISSUE_STALLED":
    case "EXECUTION_STEP_JUDGED":
      return <AlertTriangle className="h-4 w-4" />;
    case "PLAN_BUDGET_EXCEEDED":
      return <Wallet className="h-4 w-4" />;
    case "GOAL_STATUS_CHANGED":
      return notification.severity === "SUCCESS" ? (
        <CheckCircle2 className="h-4 w-4" />
      ) : (
        <Target className="h-4 w-4" />
      );
  }
}

export default function RealtimeToaster() {
  const ws = useMaybeWorkspace();
  const router = useRouter();
  const seen = useRef<Set<string>>(new Set());
  const order = useRef<string[]>([]);

  useRealtime(
    (evt) => {
      if (!ws) return;
      if (evt.id) {
        if (seen.current.has(evt.id)) return;
        seen.current.add(evt.id);
        order.current.push(evt.id);
        if (order.current.length > RECENT_LIMIT) {
          const drop = order.current.shift();
          if (drop) seen.current.delete(drop);
        }
      }

      const payload = asPayload(evt.payload);
      const notification = mapActivityEventToNotification({
        workspace: { slug: ws.slug, key: ws.key },
        event: {
          id: evt.id,
          kind: evt.kind ?? "",
          subjectType: evt.subjectType ?? "workspace",
          subjectId: evt.subjectId ?? ws.id,
          payload: evt.payload,
        },
      });

      if (notification) {
        const options = {
          description: notification.toast.description ?? notification.reason,
          icon: iconForNotification(notification),
          duration: toastDurationFor(notification),
          action: {
            label: notification.toast.actionLabel,
            onClick: () => router.push(notification.primaryHref),
          },
        };
        if (notification.severity === "ERROR" || notification.severity === "CRITICAL") {
          toast.error(notification.toast.title, options);
        } else if (notification.severity === "SUCCESS") {
          toast.success(notification.toast.title, options);
        } else if (notification.severity === "INFO") {
          toast(notification.toast.title, options);
        } else {
          toast.warning(notification.toast.title, options);
        }
        return;
      }

      switch (evt.kind) {
        case "AGENT_ASSIGNED": {
          const dispatch = payload.dispatch ?? undefined;
          const who =
            dispatch?.chosen?.name ??
            dispatch?.chosen?.profileKey ??
            payload.agentProfileKey ??
            "agent";
          const issueLabel = payload.issuePrefix ?? "issue";
          const requestMode = payload.engagementMode
            ? `${payload.engagementMode.charAt(0)}${payload.engagementMode.slice(1).toLowerCase()}`
            : null;
          const title =
            payload.via === "agent-request"
              ? `${who} requested · ${requestMode ?? "Execute"} on ${issueLabel}`
              : `${who} requested on ${issueLabel}`;
          toast(title, {
            description:
              dispatch?.reason ??
              (requestMode ? `mode: ${requestMode}` : `mode: ${dispatch?.mode ?? "manual"}`),
            icon: <UserCheck className="h-4 w-4" />,
            ...(evt.subjectType === "issue" && evt.subjectId
              ? {
                  action: {
                    label: `Open ${issueLabel}`,
                    onClick: () => router.push(`/w/${ws.slug}/issues/${evt.subjectId}`),
                  },
                }
              : {}),
          });
          return;
        }
        case "AGENT_STATUS_CHANGED": {
          if (!payload.profileKey || !payload.to) return;
          if (payload.from && payload.from === payload.to) return;
          const options = {
            icon: <Activity className="h-4 w-4" />,
            action: {
              label: "View agent",
              onClick: () => router.push(`/w/${ws.slug}/agents/${payload.profileKey}`),
            },
            ...(payload.to === "OFFLINE" ? { duration: 8_000 } : {}),
          };
          if (payload.to === "OFFLINE") {
            toast.warning(`@${payload.profileKey} went ${payload.to}`, options);
          } else {
            toast(`@${payload.profileKey} went ${payload.to}`, options);
          }
          return;
        }
        case "AGENT_DELETED": {
          if (!payload.profileKey) return;
          toast.warning(`Agent removed: @${payload.profileKey}`, {
            icon: <AlertTriangle className="h-4 w-4" />,
            duration: 8_000,
            action: {
              label: "Open agents",
              onClick: () => router.push(`/w/${ws.slug}/settings/agents`),
            },
          });
          return;
        }
        case "COMMENT_CREATED": {
          const firstRequest = payload.agentRequests?.find((r) => r.profileKey && r.mode);
          if (firstRequest) {
            const issueLabel = payload.issuePrefix ?? "issue";
            const mode = `${firstRequest.mode!.charAt(0)}${firstRequest.mode!.slice(1).toLowerCase()}`;
            toast(`@${firstRequest.profileKey} requested · ${mode} on ${issueLabel}`, {
              description:
                (payload.agentRequests?.length ?? 0) > 1
                  ? `${payload.agentRequests!.length} agent requests`
                  : "Agent request created",
              icon: <MessageCircle className="h-4 w-4" />,
              ...(evt.subjectType === "issue" && evt.subjectId
                ? {
                    action: {
                      label: `Open ${issueLabel}`,
                      onClick: () => router.push(`/w/${ws.slug}/issues/${evt.subjectId}`),
                    },
                  }
                : {}),
            });
            return;
          }
          if (!payload.mentionsCount || payload.mentionsCount <= 0) return;
          const actor = payload.actorName ?? "Someone";
          const where = payload.issuePrefix ?? "an issue";
          toast(`New mention`, {
            description: `${actor} commented on ${where}`,
            icon: <MessageCircle className="h-4 w-4" />,
            ...(evt.subjectType === "issue" && evt.subjectId
              ? {
                  action: {
                    label: `Open ${where}`,
                    onClick: () => router.push(`/w/${ws.slug}/issues/${evt.subjectId}`),
                  },
                }
              : {}),
          });
          return;
        }
        default:
          return;
      }
    },
    {
      kind: [
        "AGENT_ASSIGNED",
        "AGENT_STATUS_CHANGED",
        "AGENT_DELETED",
        "AGENT_NOACK",
        "COMMENT_CREATED",
        "ISSUE_STALLED",
        "ISSUE_SLA_BREACH",
        "GOAL_STATUS_CHANGED",
        "PLAN_BUDGET_EXCEEDED",
        "EXECUTION_STEP_JUDGED",
      ],
    },
  );

  return null;
}
