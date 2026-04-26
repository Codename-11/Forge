"use client";

import Link from "next/link";
import { Bot } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { AgentQuickActions } from "@/components/agent-quick-actions";
import { EmptyState } from "@/components/ui";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, relativeTime } from "@/lib/utils";

export default function AgentPresenceStrip() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const { data: dispatch } = trpc.analytics.dispatch.summary.useQuery({});

  useRealtime(
    () => {
      void utils.agent.list.invalidate();
      void utils.agent.pipeline.invalidate();
    },
    {
      kind: [
        "AGENT_STATUS_CHANGED",
        "AGENT_ASSIGNED",
        "AGENT_UPDATED",
        "ISSUE_STATUS_CHANGED",
      ],
    },
  );

  if (agents === undefined) {
    return (
      <div className="flex gap-2 overflow-x-auto">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="ui-shimmer h-[88px] w-[220px] shrink-0 rounded-lg border border-border bg-card/40"
            aria-hidden="true"
          />
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        variant="card"
        icon={<Bot />}
        title="No agents yet."
        description="Add agents in Settings → Agents."
      />
    );
  }

  const laneByAgent = new Map(
    (pipeline?.lanes ?? []).map((l) => [l.agent.id, l.counts]),
  );
  const dispatchByAgent = new Map(
    (dispatch?.perAgent ?? []).map((r) => [r.agentId, r]),
  );

  return (
    <div className="flex gap-2 overflow-x-auto">
      {agents.map((agent) => {
        const counts = laneByAgent.get(agent.id);
        const load = counts?.load ?? agent._count.assignedIssues;
        const max = agent.maxConcurrent;
        const unlimited = max === 0;
        const pct = unlimited ? 0 : Math.min(100, (load / Math.max(max, 1)) * 100);
        const overloaded = !unlimited && load >= max;

        const stats = dispatchByAgent.get(agent.id);
        const ttfaMin =
          stats?.meanTimeToFirstAction != null
            ? Math.round(stats.meanTimeToFirstAction / 60_000)
            : null;
        const throughput = stats?.throughputLast7d ?? 0;

        return (
          <div key={agent.id} className="relative w-[220px] shrink-0">
            <Link
              href={`/w/${ws.slug}/agents/${agent.profileKey}`}
              className="focus-ring flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 pr-7 hover:bg-subtle"
            >
              <div className="flex min-w-0 items-center gap-2">
                <AgentPresenceDot
                  status={agent.status}
                  size="md"
                  pulse
                  lastHeartbeatAt={agent.lastHeartbeatAt}
                />
                <span className="truncate text-sm font-medium text-foreground">
                  {agent.name}
                </span>
                <span className="text-meta truncate font-mono text-muted-foreground">
                  @{agent.profileKey}
                </span>
              </div>

              {unlimited ? (
                <div className="text-meta font-mono text-muted-foreground">
                  {load} active
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-subtle">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        overloaded ? "bg-warning" : "bg-ember",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-meta shrink-0 font-mono text-muted-foreground">
                    {load}/{max}
                  </span>
                </div>
              )}

              <div className="text-meta truncate text-muted-foreground">
                {throughput} done / 7d
                {ttfaMin != null && <> &middot; {ttfaMin}m</>}
                {agent.lastHeartbeatAt && (
                  <> &middot; last beat {relativeTime(agent.lastHeartbeatAt)}</>
                )}
              </div>
            </Link>
            <div className="absolute right-1 top-1">
              <AgentQuickActions
                agentId={agent.id}
                profileKey={agent.profileKey}
                name={agent.name}
                status={agent.status}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
