"use client";
import { useEffect, useState } from "react";
import { Bot, Activity } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { relativeTime } from "@/lib/utils";

/**
 * Live-pulse strip for the assigned agent's current run on this issue.
 *
 * Subscribes to the workspace SSE bus and refreshes on `agent-run.*`
 * events. Renders nothing when no ACTIVE run — the strip is invisible
 * unless work is happening, so the issue page stays calm for issues
 * that aren't currently being worked.
 *
 * Layout: a thin warm strip with a slow pulse dot, the agent name,
 * the current step (denormalized on the run row), and "updated Ns ago"
 * relative to lastEventAt. The data comes from `agentRun.activeForIssue`
 * which already includes the agent + statusComment join.
 */
export function AgentRunStrip({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils();
  const { data: run } = trpc.agentRun.activeForIssue.useQuery(
    { issueId },
    { staleTime: 5_000 },
  );
  const [now, setNow] = useState(() => Date.now());

  // Refresh the relative-time label every 10s so "updated Ns ago" stays
  // honest without re-rendering on each second tick.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  // Patch on agent-run SSE events for this run — the full query
  // refetches but the local state already updates immediately so the
  // strip feels live.
  useRealtime((evt) => {
    if (evt.subjectType !== "agent-run") return;
    const payload = evt.payload as { issueId?: string } | null;
    if (payload?.issueId !== issueId) return;
    void utils.agentRun.activeForIssue.invalidate({ issueId });
  });

  if (!run) return null;

  const elapsedMs = now - new Date(run.startedAt).getTime();
  const elapsedLabel = formatElapsed(elapsedMs);
  const lastEventLabel = relativeTime(run.lastEventAt);
  const step = run.currentStep ?? "working…";

  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-ember/30 bg-ember/5 px-3 py-1.5 text-[12px]">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
      </span>
      <Bot className="h-3.5 w-3.5 text-ember" />
      <span className="font-medium">{run.agent.name}</span>
      <span className="text-muted-foreground">·</span>
      <span className="truncate text-foreground/80">{step}</span>
      <span className="ml-auto flex items-center gap-2 text-meta text-muted-foreground">
        <Activity className="h-3 w-3" />
        <span title={`Started ${new Date(run.startedAt).toLocaleString()}`}>
          {elapsedLabel}
        </span>
        <span>·</span>
        <span title={`Last event ${new Date(run.lastEventAt).toLocaleString()}`}>
          updated {lastEventLabel}
        </span>
      </span>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
