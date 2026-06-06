"use client";
import type { AgentStatus } from "@prisma/client";
import { useEffect, useState } from "react";
import { Bell, RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { ModeChip, type EngagementModeValue } from "@/components/ui/engagement-mode-glyph";
import { STALE_RUN_MS } from "@/lib/agent-stale";
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
  engagementMode?: EngagementModeValue | null;
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
  const [now, setNow] = useState(() => Date.now());
  const { data: run } = trpc.agentRun.activeForIssue.useQuery({ issueId }, { staleTime: 5_000 });

  const invalidate = () => {
    void utils.agentRun.activeForIssue.invalidate({ issueId });
    void utils.issue.byId.invalidate({ id: issueId });
  };

  const nudgeM = trpc.agentRun.nudge.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Nudge sent");
    },
    onError: (err) => toast.error(err.message),
  });
  const kickM = trpc.agentRun.kick.useMutation({
    onSuccess: (res) => {
      invalidate();
      if (res.kicked) {
        toast.success("Run kicked");
      } else {
        toast.message("Run is still fresh", {
          description: "Kick becomes available after the run is quiet for a few minutes.",
        });
      }
    },
    onError: (err) => toast.error(err.message),
  });
  const wakeM = trpc.issue.update.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Agent wake sent");
    },
    onError: (err) => toast.error(err.message),
  });

  // Refresh on agent-run SSE events for this issue — mirrors AgentRunStrip
  // so the panel and the strip move together.
  useRealtime((evt) => {
    if (evt.subjectType !== "agent-run") return;
    const payload = evt.payload as { issueId?: string } | null;
    if (payload?.issueId !== issueId) return;
    void utils.agentRun.activeForIssue.invalidate({ issueId });
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Prefer the run's agent identity, but retain the richer runtime metadata
  // from the issue's assigned-agent payload when they refer to the same agent.
  const agent: PanelAgent | null = run?.agent
    ? mergeAgentRuntimeMetadata(run.agent, assignedAgent)
    : assignedAgent;
  if (!agent) return null;

  const waiting = run?.status === "WAITING";
  const active = run?.status === "ACTIVE";
  const idleMs = run ? now - new Date(run.lastEventAt).getTime() : 0;
  const staleActive = active && idleMs >= STALE_RUN_MS;
  const busy = nudgeM.isPending || kickM.isPending || wakeM.isPending;
  const mode = run?.engagementMode ?? assignedAgent?.engagementMode ?? null;
  const runAction =
    run && waiting
      ? {
          label: "Nudge",
          title: "Post an @mention to wake this waiting run",
          icon: Bell,
          onClick: () =>
            nudgeM.mutate({
              runId: run.id,
              message: "please resume with the latest issue context",
            }),
        }
      : run && staleActive
        ? {
            label: "Kick",
            title: "Re-fire the wake event for this stale active run",
            icon: RefreshCw,
            onClick: () => kickM.mutate({ runId: run.id }),
          }
        : !run && assignedAgent
          ? {
              label: "Wake",
              title: "Wake the assigned agent without changing assignment",
              icon: Zap,
              onClick: () =>
                wakeM.mutate({
                  id: issueId,
                  assignedAgentId: assignedAgent.id,
                  mode: assignedAgent.engagementMode ?? "EXECUTE",
                }),
            }
          : null;

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
        {runAction && (
          <button
            type="button"
            onClick={runAction.onClick}
            disabled={busy}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 text-[0.625rem] font-medium text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
              waiting && "border-ember/30 text-ember hover:text-ember",
            )}
            title={runAction.title}
          >
            <runAction.icon
              className={cn(
                "h-3 w-3",
                ((runAction.label === "Kick" && kickM.isPending) || wakeM.isPending) &&
                  "animate-spin",
              )}
            />
            <span>{runAction.label}</span>
          </button>
        )}
      </div>
      <div className="text-meta mt-2 grid gap-1.5 text-muted-foreground">
        {mode && (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/80">
              Mode
            </span>
            <ModeChip
              mode={mode}
              title="Engagement mode changes the work contract only. It does not grant terminal, filesystem, or git tools."
            />
            <span
              className="min-w-0 truncate"
              title="Terminal, filesystem, and git access come from the runtime/tool surface."
            >
              instructions only
            </span>
          </div>
        )}
        <RuntimeSurfaceRow agent={agent} />
      </div>
      <div className="text-meta mt-1.5 text-muted-foreground">
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

function mergeAgentRuntimeMetadata(
  runAgent: PanelAgent,
  assignedAgent: PanelAgent | null,
): PanelAgent {
  if (!assignedAgent || assignedAgent.id !== runAgent.id) return runAgent;
  return { ...assignedAgent, ...runAgent };
}

function RuntimeSurfaceRow({ agent }: { agent: PanelAgent }) {
  const runtime = runtimeSurface(agent);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground/80">
        Runtime
      </span>
      <span
        className={cn(
          "min-w-0 truncate rounded-md border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider",
          runtime.configured
            ? "border-border bg-card/40 text-muted-foreground"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
        title={runtime.title}
      >
        {runtime.label}
      </span>
      <span className="min-w-0 truncate" title={runtime.toolTitle}>
        {runtime.tools}
      </span>
    </div>
  );
}

function runtimeSurface(agent: PanelAgent): {
  label: string;
  tools: string;
  title: string;
  toolTitle: string;
  configured: boolean;
} {
  const provider = normalizeProvider(agent.provider);
  const runtimeMode = agent.runtimeMode === "EPHEMERAL" ? "session" : "persistent";

  if (provider === "HERMES") {
    return {
      label: `Hermes ${runtimeMode}`,
      tools: "tools from Hermes host",
      title:
        "Agent identity is Hermes-backed. Forge dispatches to the Hermes runtime; Forge does not add local terminal tools.",
      toolTitle:
        "Terminal, filesystem, and git access depend on the Hermes host that receives this work.",
      configured: true,
    };
  }

  if (agent.runtimeId) {
    return {
      label: `${providerLabel(provider)} runtime`,
      tools: "tools from attached runtime",
      title:
        "This agent has an attached managed runtime. Tool access is whatever that runtime exposes.",
      toolTitle: "Changing Execute/Review/Research does not change the runtime tool surface.",
      configured: true,
    };
  }

  if (agent.webhookUrl) {
    return {
      label: "remote webhook",
      tools: "tools from webhook receiver",
      title:
        "Forge reaches this agent through its configured webhook. The receiver decides which tools exist.",
      toolTitle:
        "Execute mode asks the webhook receiver to do execution work, but does not grant terminal, filesystem, or git access.",
      configured: true,
    };
  }

  return {
    label: "unattached",
    tools: "tool surface unknown",
    title: "No runtime or webhook metadata is attached to this agent.",
    toolTitle:
      "Attach a runtime or webhook before expecting terminal, filesystem, or git-backed work.",
    configured: false,
  };
}

function normalizeProvider(provider: string | null | undefined): string | null {
  const trimmed = provider?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function providerLabel(provider: string | null): string {
  if (!provider) return "agent";
  return provider
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
