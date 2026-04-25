"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRightLeft,
  Bot,
  History,
  Inbox,
  MessageCircle,
  UserCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { EmptyState, SkeletonList } from "@/components/ui";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, relativeTime } from "@/lib/utils";

type TimelineEvent = {
  id: string;
  kind:
    | "AGENT_CREATED"
    | "AGENT_UPDATED"
    | "AGENT_DELETED"
    | "AGENT_ASSIGNED"
    | "AGENT_STATUS_CHANGED"
    | "ISSUE_QUEUED"
    | "ISSUE_STATUS_CHANGED"
    | "COMMENT_CREATED";
  createdAt: Date | string;
  actor: { id: string; name: string | null; image: string | null } | null;
  subjectType: string;
  subjectId: string;
  issue: {
    id: string;
    number: number;
    title: string;
    workspace: { key: string };
    status: { id: string; name: string; category: string; color: string };
    project: { id: string; key: string; name: string; color: string | null } | null;
    assignedAgent: { id: string; name: string; profileKey: string } | null;
  } | null;
  agent: {
    id: string;
    name: string;
    profileKey: string;
    avatar: string | null;
    status: "ONLINE" | "OFFLINE" | "BUSY";
  } | null;
  payload: unknown;
};

function iconFor(kind: TimelineEvent["kind"]) {
  switch (kind) {
    case "AGENT_ASSIGNED":
      return <UserCheck className="h-3.5 w-3.5 text-muted-foreground" />;
    case "AGENT_STATUS_CHANGED":
      return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
    case "AGENT_CREATED":
    case "AGENT_UPDATED":
    case "AGENT_DELETED":
      return <Bot className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_STATUS_CHANGED":
      return <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />;
    case "ISSUE_QUEUED":
      return <Inbox className="h-3.5 w-3.5 text-muted-foreground" />;
    case "COMMENT_CREATED":
      return <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />;
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
    case "AGENT_ASSIGNED": {
      const mode = readPayloadString(evt.payload, "mode");
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
    case "AGENT_CREATED":
    case "AGENT_UPDATED":
    case "AGENT_DELETED": {
      const verb =
        evt.kind === "AGENT_CREATED"
          ? "created"
          : evt.kind === "AGENT_UPDATED"
            ? "updated"
            : "deleted";
      const agentName = evt.agent?.name ?? "agent";
      return {
        headline: (
          <>
            {actorName} {verb} agent {agentName}
          </>
        ),
      };
    }
    case "ISSUE_STATUS_CHANGED": {
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
    }
    case "ISSUE_QUEUED": {
      return {
        headline: (
          <>
            {actorName} queued {issueLink} for an agent
          </>
        ),
        meta: issue ? <span className="truncate">{issue.title}</span> : undefined,
      };
    }
    case "COMMENT_CREATED": {
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
}

export default function AgentTimeline() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const { data } = trpc.agent.timeline.useQuery({ agentId, cursor, limit: 50 });
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });

  useRealtime(
    () => {
      void utils.agent.timeline.invalidate();
    },
    {
      kind: [
        "AGENT_CREATED",
        "AGENT_UPDATED",
        "AGENT_DELETED",
        "AGENT_ASSIGNED",
        "AGENT_STATUS_CHANGED",
        "ISSUE_QUEUED",
        "ISSUE_STATUS_CHANGED",
        "COMMENT_CREATED",
      ],
    },
  );

  const chips = (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setAgentId(undefined);
          setCursor(undefined);
        }}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
          agentId === undefined
            ? "border-ember bg-ember/10 text-ember"
            : "border-border bg-card text-muted-foreground hover:text-foreground",
        )}
      >
        All
      </button>
      {(agents ?? []).map((a) => {
        const active = agentId === a.id;
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              setAgentId(a.id);
              setCursor(undefined);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              active
                ? "border-ember bg-ember/10 text-ember"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            <AgentPresenceDot status={a.status} size="sm" />
            <span className={cn(active ? "text-ember" : "text-foreground")}>
              {a.name}
            </span>
            <span className="font-mono opacity-70">@{a.profileKey}</span>
          </button>
        );
      })}
    </div>
  );

  if (data === undefined) {
    return (
      <div className="flex flex-col gap-3">
        {chips}
        <SkeletonList rows={6} />
      </div>
    );
  }

  const events = data.events as TimelineEvent[];

  if (events.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {chips}
        <EmptyState
          variant="card"
          icon={<History />}
          title="No agent activity yet."
          description="Events will appear here as agents pick up issues, comment, and complete work."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {chips}
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {events.map((evt) => {
          const { headline, meta } = summarizeEvent(evt, ws.slug);
          return (
            <li
              key={evt.id}
              className="flex items-start gap-2 px-3 py-2 text-[12px]"
            >
              <span className="mt-0.5 shrink-0">{iconFor(evt.kind)}</span>
              <div className="flex-1 min-w-0">
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
      {data.nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setCursor(data.nextCursor ?? undefined)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Load older
          </button>
        </div>
      )}
    </div>
  );
}
