"use client";
import type { AgentStatus } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { presenceAvailability } from "@/lib/transport-display";
import { relativeTime, cn } from "@/lib/utils";

/**
 * Persistent agent-status panel for the issue right rail. The rail is
 * sticky, so this stays in view while the operator scrolls a long
 * comment thread — unlike the top-of-page AgentRunStrip, which scrolls
 * away. Shows the assigned agent's presence dot plus the live run state
 * (working / waiting on you), refreshed over SSE. Renders nothing when
 * the issue has neither an assigned agent nor an active run, so quiet
 * issues keep the rail uncluttered.
 */

type PanelAgent = {
  id: string;
  name: string;
  profileKey: string;
  avatar: string | null;
  status: AgentStatus;
  // On-demand availability signals (optional — present on enriched queries).
  provider?: string | null;
  runtimeMode?: string | null;
  lastHeartbeatAt?: Date | string | null;
  webhookUrl?: string | null;
  runtimeId?: string | null;
};

export function IssueAgentPanel({
  issueId,
  assignedAgent,
}: {
  issueId: string;
  assignedAgent: PanelAgent | null;
}) {
  const utils = trpc.useUtils();
  const { data: run } = trpc.agentRun.activeForIssue.useQuery(
    { issueId },
    { staleTime: 5_000 },
  );

  // Refresh on agent-run SSE events for this issue — mirrors AgentRunStrip
  // so the panel and the strip move together.
  useRealtime((evt) => {
    if (evt.subjectType !== "agent-run") return;
    const payload = evt.payload as { issueId?: string } | null;
    if (payload?.issueId !== issueId) return;
    void utils.agentRun.activeForIssue.invalidate({ issueId });
  });

  // Prefer the run's agent (freshest), else the statically-assigned one.
  const agent: PanelAgent | null = run?.agent ?? assignedAgent;
  if (!agent) return null;

  const waiting = run?.status === "WAITING";
  const active = run?.status === "ACTIVE";

  return (
    <div
      className={cn(
        "rounded-md border p-2.5",
        waiting ? "border-ember/40 bg-ember/[0.06]" : "border-border bg-card/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="relative inline-flex shrink-0">
          <AgentAvatar agent={agent} size="sm" shape="circle" active={active} />
          <span className="absolute -bottom-0.5 -right-0.5">
            <AgentPresenceDot
              status={agent.status}
              size="sm"
              availability={presenceAvailability(agent)}
            />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{agent.name}</div>
          <div className="text-id text-muted-foreground">@{agent.profileKey}</div>
        </div>
        {run &&
          (waiting ? (
            <span className="shrink-0 rounded-full border border-ember/40 bg-ember/10 px-1.5 py-0.5 text-[0.5625rem] font-medium uppercase tracking-wider text-ember">
              waiting
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 text-[0.5625rem] font-medium uppercase tracking-wider text-ember">
              <span className="h-1.5 w-1.5 rounded-full bg-ember motion-safe:animate-pulse" />
              working
            </span>
          ))}
      </div>
      <div className="mt-1.5 text-meta text-muted-foreground">
        {run ? (
          <>
            {waiting ? "Waiting on your reply" : run.currentStep || "working…"}
            <span className="text-muted-foreground/60">
              {" · "}updated {relativeTime(run.lastEventAt)}
            </span>
          </>
        ) : (
          "Assigned · no active run"
        )}
      </div>
    </div>
  );
}
