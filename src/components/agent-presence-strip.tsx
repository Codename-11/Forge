"use client";

import Link from "next/link";
import { AlertTriangle, Bot } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { AgentQuickActions } from "@/components/agent-quick-actions";
import { EmptyState } from "@/components/ui";
import { useRealtime } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Severity of a heartbeat-lag for a PERSISTENT agent. EPHEMERAL agents
 * only beat while running, so the strip suppresses the warning for
 * them and this helper returns "ok" for any age.
 */
type HeartbeatSeverity = "ok" | "warn" | "critical";

function heartbeatSeverity(args: {
  lastHeartbeatAt: Date | string | null;
  runtimeMode: "PERSISTENT" | "EPHEMERAL";
  warnMinutes: number;
  criticalMinutes: number;
}): HeartbeatSeverity {
  if (args.runtimeMode !== "PERSISTENT") return "ok";
  if (!args.lastHeartbeatAt) {
    // No heartbeat ever recorded for a PERSISTENT agent — that's worth
    // warning about, but we don't have an age to compare. Treat as warn
    // (not critical) so we don't escalate something that may just be a
    // newly-created agent.
    return args.warnMinutes > 0 ? "warn" : "ok";
  }
  const ageMs =
    Date.now() - new Date(args.lastHeartbeatAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "ok";
  const ageMin = ageMs / 60_000;
  if (args.criticalMinutes > 0 && ageMin >= args.criticalMinutes) {
    return "critical";
  }
  if (args.warnMinutes > 0 && ageMin >= args.warnMinutes) {
    return "warn";
  }
  return "ok";
}

export default function AgentPresenceStrip() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: pipeline } = trpc.agent.pipeline.useQuery({});
  const { data: dispatch } = trpc.analytics.dispatch.summary.useQuery({});
  const { data: workspace } = trpc.workspace.current.useQuery();

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

  // Settings-driven thresholds (Bailey's no-magic-numbers rule). Read
  // off Workspace.agentHeartbeat{Warn,Critical}Minutes; fall back to
  // sane defaults when the workspace row hasn't loaded yet so the UI
  // never flickers from "warn" → "ok" on hydration.
  const warnMinutes = workspace?.agentHeartbeatWarnMinutes ?? 5;
  const criticalMinutes = workspace?.agentHeartbeatCriticalMinutes ?? 30;

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

        const severity = heartbeatSeverity({
          lastHeartbeatAt: agent.lastHeartbeatAt,
          runtimeMode: agent.runtimeMode,
          warnMinutes,
          criticalMinutes,
        });
        const beatAgeMin = agent.lastHeartbeatAt
          ? Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(agent.lastHeartbeatAt).getTime()) /
                  60_000,
              ),
            )
          : null;
        const beatTitle =
          severity === "critical"
            ? `Last heartbeat ${beatAgeMin ?? "?"} min ago — critical threshold ${criticalMinutes}m`
            : severity === "warn"
              ? `Last heartbeat ${beatAgeMin ?? "?"} min ago — warn threshold ${warnMinutes}m`
              : undefined;

        return (
          <div key={agent.id} className="relative w-[220px] shrink-0">
            <Link
              href={`/w/${ws.slug}/agents/${agent.profileKey}`}
              className={cn(
                "focus-ring flex w-full flex-col gap-2 rounded-lg border bg-card p-3 pr-7 hover:bg-subtle",
                severity === "critical"
                  ? "border-danger/40"
                  : severity === "warn"
                    ? "border-warning/40"
                    : "border-border",
              )}
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
                {severity !== "ok" && (
                  <span
                    title={beatTitle}
                    className={cn(
                      "ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wider",
                      severity === "critical"
                        ? "bg-danger/10 text-danger"
                        : "bg-warning/10 text-warning",
                    )}
                  >
                    <AlertTriangle aria-hidden className="h-3 w-3" />
                    {severity === "critical" ? "Down" : "Lag"}
                  </span>
                )}
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

              <div
                className={cn(
                  "text-meta truncate",
                  severity === "critical"
                    ? "text-danger"
                    : severity === "warn"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              >
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
