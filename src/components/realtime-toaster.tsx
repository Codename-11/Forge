"use client";
import { useRef } from "react";
import { toast } from "sonner";
import {
  UserCheck,
  Activity,
  AlertTriangle,
  MessageCircle,
} from "lucide-react";
import { useRealtime } from "@/hooks/use-realtime";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

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
  slaMinutes?: number;
};

function asPayload(p: unknown): EventPayload {
  if (!p || typeof p !== "object") return {};
  return p as EventPayload;
}

const RECENT_LIMIT = 100;

export default function RealtimeToaster() {
  const ws = useMaybeWorkspace();
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

      switch (evt.kind) {
        case "AGENT_ASSIGNED": {
          const dispatch = payload.dispatch ?? undefined;
          const who = dispatch?.chosen?.name ?? "agent";
          const subject = evt.subjectId ?? "an issue";
          toast(`Dispatch: ${who} took ${subject}`, {
            description:
              dispatch?.reason ?? `mode: ${dispatch?.mode ?? "manual"}`,
            icon: <UserCheck className="h-4 w-4" />,
          });
          return;
        }
        case "AGENT_STATUS_CHANGED": {
          if (!payload.profileKey || !payload.to) return;
          if (payload.from && payload.from === payload.to) return;
          toast(`@${payload.profileKey} went ${payload.to}`, {
            icon: <Activity className="h-4 w-4" />,
          });
          return;
        }
        case "AGENT_DELETED": {
          if (!payload.profileKey) return;
          toast.warning(`Agent removed: @${payload.profileKey}`, {
            icon: <AlertTriangle className="h-4 w-4" />,
          });
          return;
        }
        case "COMMENT_CREATED": {
          if (!payload.mentionsCount || payload.mentionsCount <= 0) return;
          const actor = payload.actorName ?? "Someone";
          const where = payload.issuePrefix ?? "an issue";
          toast(`New mention`, {
            description: `@${actor} commented on ${where}`,
            icon: <MessageCircle className="h-4 w-4" />,
          });
          return;
        }
        case "ISSUE_STALLED": {
          const prefix = payload.issuePrefix ?? evt.subjectId ?? "an issue";
          toast.warning(`Stalled: ${prefix} hasn't moved`, {
            description: payload.agentProfileKey
              ? `Assigned @${payload.agentProfileKey}${
                  payload.slaMinutes ? ` · ${payload.slaMinutes}m SLA` : ""
                }`
              : undefined,
            icon: <AlertTriangle className="h-4 w-4" />,
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
        "COMMENT_CREATED",
        "ISSUE_STALLED",
      ],
    },
  );

  return null;
}
