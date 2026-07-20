"use client";

import type { AgentStatus } from "@prisma/client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronDown,
  FolderOpen,
  GitBranch,
  History,
  RefreshCw,
  Square,
  Terminal,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { RunApprovalCard } from "@/components/agents/run-approval-card";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { RunTimeline } from "@/components/mission-control/run-timeline";
import { RuntimePolicyBadges } from "@/components/runtime-tool-surface";
import {
  EngagementModeGlyph,
  MODE_LABEL,
  MODE_ORDER,
  MODE_SUBTITLE,
  type EngagementModeValue,
} from "@/components/ui/engagement-mode-glyph";
import { useRealtime, useRealtimeConnection } from "@/hooks/use-realtime";
import { useWorkspace } from "@/hooks/use-workspace";
import type { RuntimePolicySnapshot } from "@/lib/runtime-enforcement";
import type { RuntimeToolCapability } from "@/lib/runtime-tools";
import { workstreamRunProvenance } from "@/lib/run-provenance";
import { trpc } from "@/lib/trpc";
import { presenceAvailability } from "@/lib/transport-display";
import { cn, relativeTime } from "@/lib/utils";
import { useConfirm } from "@/components/ui/modal";

type WorkstreamAgent = {
  id: string;
  name: string;
  profileKey: string;
  avatar?: string | null;
  status?: AgentStatus;
  engagementMode?: EngagementModeValue | null;
  provider?: string | null;
  runtimeMode?: string | null;
  lastHeartbeatAt?: Date | string | null;
  webhookUrl?: string | null;
  runtimeId?: string | null;
  runtime?: {
    name?: string | null;
    adapterKey?: string | null;
    config?: unknown;
  } | null;
};

export type WorkstreamLatestRun = {
  id: string;
  status: string;
  startedAt: Date | string;
  lastEventAt: Date | string;
  finishedAt?: Date | string | null;
  currentStep?: string | null;
  summary?: string | null;
  engagementMode?: string | null;
  runtimePolicy?: unknown;
  externalRunId?: string | null;
  connection?: {
    kind: "MCP_CLIENT" | "MANAGED_RUNTIME" | "WEBHOOK" | "ON_DEMAND";
    displayName?: string | null;
    clientName?: string | null;
    runtime?: { name?: string | null } | null;
  } | null;
  agent: WorkstreamAgent;
};

type WorkstreamState =
  | "assigned"
  | "queued"
  | "wake-sent"
  | "acknowledged"
  | "working"
  | "quiet"
  | "waiting"
  | "completed"
  | "stalled"
  | "stopped"
  | "errored";

/**
 * The issue's single operational surface for agent work.
 *
 * Unlike the former repeated pulse strips, Workstream keeps identity,
 * contract, runtime, controls, rolling status, and the event trace together.
 * Active runs open their trace automatically; terminal history stays calm and
 * collapsed. A quiet ACTIVE run is explicitly labelled Quiet — only a
 * canonical persisted STALLED status is ever called Stalled.
 */
export function AgentRunStrip({
  issueId,
  assignedAgent = null,
  latestRun = null,
  activityHref,
}: {
  issueId: string;
  assignedAgent?: WorkstreamAgent | null;
  latestRun?: WorkstreamLatestRun | null;
  activityHref?: string;
}) {
  const utils = trpc.useUtils();
  const workspace = useWorkspace();
  const realtime = useRealtimeConnection();
  const { data: activeRun } = trpc.agentRun.activeForIssue.useQuery(
    { issueId },
    { staleTime: 5_000 },
  );
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const initializedRunId = useRef<string | null>(null);

  const relevantLatestRun =
    latestRun && (!assignedAgent || latestRun.agent.id === assignedAgent.id) ? latestRun : null;
  const displayRun = activeRun ?? relevantLatestRun;
  const isActiveRun = Boolean(
    activeRun || (displayRun && ["ACTIVE", "WAITING"].includes(displayRun.status.toUpperCase())),
  );
  const displayAgent = mergeAgent(
    activeRun?.agent ?? relevantLatestRun?.agent ?? null,
    assignedAgent,
  );
  const quietMs =
    workspace.agentRunQuietMinutes > 0 ? workspace.agentRunQuietMinutes * 60_000 : null;
  const state = deriveWorkstreamState(activeRun ?? relevantLatestRun, now, isActiveRun, quietMs);
  const policy = (displayRun?.runtimePolicy ?? null) as RuntimePolicySnapshot | null;

  const { data: events } = trpc.agentRun.events.useQuery(
    { runId: displayRun?.id ?? "", limit: 10 },
    { enabled: Boolean(displayRun?.id) && expanded, staleTime: 5_000 },
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!displayRun || initializedRunId.current === displayRun.id) return;
    initializedRunId.current = displayRun.id;
    setExpanded(
      isActiveRun && (state === "working" || state === "acknowledged" || state === "wake-sent"),
    );
  }, [displayRun, isActiveRun, state]);

  useRealtime((event) => {
    if (event.subjectType !== "agent-run") return;
    const payload = event.payload as { issueId?: string } | null;
    if (payload?.issueId !== issueId) return;
    void utils.agentRun.activeForIssue.invalidate({ issueId });
    if (displayRun?.id) {
      void utils.agentRun.events.invalidate({ runId: displayRun.id, limit: 10 });
    }
  });

  if (!displayAgent && !displayRun) return null;

  const mode = normalizeMode(
    displayRun?.engagementMode ?? activeRun?.engagementMode ?? assignedAgent?.engagementMode,
  );
  const elapsedLabel = displayRun
    ? formatElapsed(now - new Date(displayRun.startedAt).getTime())
    : null;
  const lastSignalLabel = displayRun ? relativeTime(displayRun.lastEventAt) : null;
  const liveStep =
    activeRun?.currentStep ??
    activeRun?.statusComment?.currentStep ??
    relevantLatestRun?.currentStep ??
    null;
  // Historical rows may contain a buffered provider step written around the
  // completion boundary. Terminal presentation is owned by lifecycle state,
  // never by a stale live-step label.
  const step = isActiveRun ? (liveStep ?? stateCopy(state)) : stateCopy(state);
  const statusBody = activeRun?.statusComment?.body?.trim();
  const statusTone = stateTone(state);

  return (
    <section
      aria-label="Agent workstream"
      className={cn("mb-5 overflow-hidden rounded-lg border bg-card/40", statusTone.container)}
    >
      <div className="flex min-w-0 flex-col gap-3 px-3 py-3 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <button
            type="button"
            onClick={() => displayRun && setExpanded((value) => !value)}
            disabled={!displayRun}
            className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md text-left disabled:cursor-default"
            aria-expanded={displayRun ? expanded : undefined}
            aria-controls={displayRun ? `workstream-events-${displayRun.id}` : undefined}
          >
            {displayAgent ? (
              <span className="relative inline-flex shrink-0">
                <AgentAvatar
                  agent={displayAgent}
                  size="md"
                  shape="circle"
                  active={state === "working" || state === "acknowledged"}
                />
                {displayAgent.status ? (
                  <span className="absolute -bottom-0.5 -right-0.5">
                    <AgentPresenceDot
                      status={displayAgent.status}
                      size="sm"
                      availability={presenceAvailability(displayAgent)}
                    />
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-semibold text-foreground">Workstream</span>
                {displayAgent ? (
                  <>
                    <span className="truncate text-xs font-medium text-foreground">
                      {displayAgent.name}
                    </span>
                    <span className="text-id text-muted-foreground">
                      @{displayAgent.profileKey}
                    </span>
                  </>
                ) : null}
                <StateBadge state={state} />
              </span>
              <span className="text-meta mt-0.5 block truncate text-muted-foreground" title={step}>
                {step}
              </span>
            </span>
            {displayRun ? (
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            ) : null}
          </button>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {isActiveRun ? <RealtimeBadge status={realtime.status} /> : null}
            {activityHref ? (
              <Link
                href={activityHref}
                className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground"
              >
                <History className="h-3.5 w-3.5" />
                Activity
              </Link>
            ) : null}
            <WorkstreamActions
              issueId={issueId}
              runId={isActiveRun ? (displayRun?.id ?? null) : null}
              agent={assignedAgent ?? displayAgent}
              quiet={state === "quiet"}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
          {mode ? <WorkModeBadge mode={mode} /> : null}
          {displayAgent ? <ExecutionProvenanceBadge agent={displayAgent} run={displayRun} /> : null}
          <RuntimePolicyBadges compact policy={policy} />
          <RuntimeToolBadges policy={policy} />
          <ProtocolDiagnostics diagnostics={activeRun?.protocolDiagnostics} />
          {displayRun ? (
            <span className="text-meta ml-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              <span title={`Started ${new Date(displayRun.startedAt).toLocaleString()}`}>
                {elapsedLabel}
              </span>
              <span aria-hidden>·</span>
              <span title={`Last signal ${new Date(displayRun.lastEventAt).toLocaleString()}`}>
                last signal {lastSignalLabel}
              </span>
            </span>
          ) : null}
        </div>

        {statusBody && statusBody !== step ? (
          <div className="rounded-md border border-border/60 bg-background/40 px-2.5 py-2">
            <div className="text-meta mb-1 font-medium uppercase tracking-wide text-muted-foreground">
              Current status
            </div>
            <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
              {statusBody}
            </p>
          </div>
        ) : null}

        {activeRun?.awaitingApprovalAt ? (
          <RunApprovalCard
            runId={activeRun.id}
            agentName={activeRun.agent.name}
            pendingApproval={activeRun.pendingApproval}
            onResolved={() => {
              void utils.agentRun.activeForIssue.invalidate({ issueId });
              void utils.issue.byId.invalidate({ id: issueId });
              void utils.commandCenter.summary.invalidate();
              void utils.commandCenter.decisionsCount.invalidate();
            }}
          />
        ) : null}
      </div>

      {displayRun && expanded ? (
        <div
          id={`workstream-events-${displayRun.id}`}
          className="border-t border-border bg-background/30 px-3 py-2.5 sm:px-4"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-meta font-medium uppercase tracking-wide text-muted-foreground">
              Live trace
            </span>
            <span className="text-meta text-muted-foreground">Latest 10 events</span>
          </div>
          <RunTimeline events={events ?? []} />
        </div>
      ) : null}

      {isActiveRun && mode && displayRun ? (
        <div className="border-t border-border bg-card/20 px-3 py-2 sm:px-4">
          <RunModeControl issueId={issueId} runId={displayRun.id} mode={mode} />
        </div>
      ) : null}
    </section>
  );
}

function WorkstreamActions({
  issueId,
  runId,
  agent,
  quiet,
}: {
  issueId: string;
  runId: string | null;
  agent: WorkstreamAgent | null;
  quiet: boolean;
}) {
  const utils = trpc.useUtils();
  const [confirmStop, setConfirmStop] = useState(false);
  const invalidate = () => {
    void utils.agentRun.activeForIssue.invalidate({ issueId });
    void utils.issue.byId.invalidate({ id: issueId });
    void utils.agentRun.activeAll.invalidate();
    void utils.issue.queue.invalidate();
  };
  const nudgeM = trpc.agentRun.nudge.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Nudge sent");
    },
    onError: (error) => toast.error(error.message),
  });
  const kickM = trpc.agentRun.kick.useMutation({
    onSuccess: (result) => {
      invalidate();
      if (result.kicked) toast.success("Run kicked");
      else toast.message("Run is still fresh");
    },
    onError: (error) => toast.error(error.message),
  });
  const abandonM = trpc.agentRun.abandon.useMutation({
    onSuccess: () => {
      invalidate();
      setConfirmStop(false);
      toast.success("Run stopped");
    },
    onError: (error) => toast.error(error.message),
  });
  const wakeM = trpc.issue.update.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success("Agent wake sent");
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = nudgeM.isPending || kickM.isPending || abandonM.isPending || wakeM.isPending;
  const buttonClass =
    "focus-ring inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

  if (confirmStop && runId) {
    return (
      <div className="flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 p-0.5">
        <span className="px-1 text-[0.6875rem] text-foreground">Stop run?</span>
        <button
          type="button"
          className={cn(buttonClass, "h-6 border-warning/30 text-warning")}
          disabled={busy}
          onClick={() => abandonM.mutate({ runId })}
        >
          Stop
        </button>
        <button
          type="button"
          className={cn(buttonClass, "h-6")}
          onClick={() => setConfirmStop(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (!runId && agent) {
    return (
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        onClick={() =>
          wakeM.mutate({
            id: issueId,
            assignedAgentId: agent.id,
            mode: agent.engagementMode ?? "EXECUTE",
          })
        }
        title="Wake the assigned agent"
      >
        <Zap className={cn("h-3.5 w-3.5", wakeM.isPending && "animate-pulse")} />
        Wake
      </button>
    );
  }

  if (!runId) return null;
  return (
    <>
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        onClick={() =>
          nudgeM.mutate({ runId, message: "Please share a concise progress checkpoint." })
        }
        title="Ask the agent for a progress checkpoint"
      >
        <Bell className="h-3.5 w-3.5" />
        Nudge
      </button>
      {quiet ? (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => kickM.mutate({ runId })}
          title="Re-fire the wake event for this quiet run"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", kickM.isPending && "animate-spin")} />
          Kick
        </button>
      ) : null}
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        onClick={() => setConfirmStop(true)}
        title="Stop this run"
      >
        <Square className="h-3 w-3" />
        Stop
      </button>
    </>
  );
}

function StateBadge({ state }: { state: WorkstreamState }) {
  const tone = stateTone(state);
  const live = state === "working" || state === "acknowledged";
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider",
        tone.badge,
      )}
      title={stateDescription(state)}
    >
      <span className="relative flex h-1.5 w-1.5">
        {live ? (
          <span
            className={cn("absolute inline-flex h-full w-full animate-ping rounded-full", tone.dot)}
          />
        ) : null}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", tone.dot)} />
      </span>
      {stateLabel(state)}
    </span>
  );
}

function RealtimeBadge({ status }: { status: "connecting" | "live" | "reconnecting" | "offline" }) {
  if (status === "live") {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground"
        title="Workstream updates are live"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        Live
      </span>
    );
  }
  const offline = status === "offline";
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[0.625rem] font-semibold uppercase tracking-wider",
        offline
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-warning/30 bg-warning/10 text-warning",
      )}
      title={
        offline
          ? "Realtime is offline; periodic query refresh remains available"
          : "The live stream is reconnecting; periodic query refresh remains available"
      }
    >
      <RefreshCw className={cn("h-3 w-3", !offline && "animate-spin")} />
      {offline ? "Offline · polling" : status === "connecting" ? "Connecting" : "Reconnecting"}
    </span>
  );
}

function WorkModeBadge({ mode }: { mode: EngagementModeValue }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-ember/30 bg-ember/10 px-2 py-1 text-ember"
      title={`${MODE_LABEL[mode]} — ${MODE_SUBTITLE[mode]}`}
    >
      <EngagementModeGlyph mode={mode} size={13} />
      <span className="text-[0.625rem] font-semibold uppercase tracking-wider">
        {MODE_LABEL[mode]}
      </span>
    </span>
  );
}

function ExecutionProvenanceBadge({
  agent,
  run,
}: {
  agent: WorkstreamAgent;
  run: WorkstreamLatestRun | null;
}) {
  const configuredRuntimeName =
    agent.runtime?.name ?? providerLabel(agent.provider) ?? (agent.runtimeId ? "Runtime" : null);
  const provenance = workstreamRunProvenance({
    run,
    configuredRuntimeName,
    configuredRuntimeMode: agent.runtimeMode,
  });
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-1 font-mono text-[0.625rem] uppercase tracking-wider",
        provenance.recorded
          ? "border-border bg-background/60 text-muted-foreground"
          : "border-warning/30 bg-warning/10 text-warning",
      )}
      title={provenance.description}
    >
      {provenance.label}
    </span>
  );
}

const TOOL_ICONS: Record<RuntimeToolCapability, typeof Terminal> = {
  terminal: Terminal,
  filesystem: FolderOpen,
  git: GitBranch,
};

function RuntimeToolBadges({ policy }: { policy: RuntimePolicySnapshot | null }) {
  if (!policy) return null;
  const allowedHostTools = policy.allowedHostTools ?? [];
  if (allowedHostTools.length === 0) {
    return (
      <span
        className="rounded-md border border-border bg-background/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
        title="This run has no host tools in its effective policy"
      >
        no host tools
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {allowedHostTools.map((tool) => {
        const Icon = TOOL_ICONS[tool];
        return (
          <span
            key={tool}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
            title={`${tool} allowed by this run's effective host policy`}
          >
            <Icon className="h-3 w-3" />
            {tool}
          </span>
        );
      })}
    </div>
  );
}

function ProtocolDiagnostics({
  diagnostics,
}: {
  diagnostics?: Array<{ code: string; severity: string; title: string; description: string }>;
}) {
  const actionable = diagnostics?.filter((diagnostic) => diagnostic.severity !== "info") ?? [];
  if (actionable.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {actionable.slice(0, 2).map((diagnostic) => (
        <span
          key={diagnostic.code}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider",
            diagnostic.severity === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-warning/30 bg-warning/10 text-warning",
          )}
          title={diagnostic.description}
        >
          <AlertTriangle className="h-3 w-3" />
          {diagnostic.title}
        </span>
      ))}
    </div>
  );
}

function RunModeControl({
  issueId,
  runId,
  mode,
}: {
  issueId: string;
  runId: string;
  mode: EngagementModeValue;
}) {
  const { confirm, confirmElement } = useConfirm();
  const utils = trpc.useUtils();
  const restartM = trpc.agentRun.restartWithMode.useMutation({
    onSuccess: (result) => {
      void utils.agentRun.activeForIssue.invalidate({ issueId });
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.recentTerminal.invalidate();
      void utils.issue.byId.invalidate({ id: issueId });
      if (result.restarted) {
        toast.success(`Restarted as ${MODE_LABEL[result.mode as EngagementModeValue]}`);
      } else {
        toast.message("Run already uses that mode");
      }
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-meta shrink-0 text-muted-foreground">Restart as</span>
      <div
        role="group"
        aria-label="Run engagement mode"
        title="Mode is fixed per run. Pick another mode to stop this run and restart with that contract."
        className="flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-md border border-border bg-background/80 p-0.5"
      >
        {MODE_ORDER.map((nextMode) => {
          const active = mode === nextMode;
          return (
            <button
              key={nextMode}
              type="button"
              aria-pressed={active}
              aria-label={
                active
                  ? `Current run mode ${MODE_LABEL[nextMode]}`
                  : `Stop current run and restart as ${MODE_LABEL[nextMode]}`
              }
              title={
                active
                  ? `${MODE_LABEL[nextMode]} — ${MODE_SUBTITLE[nextMode]}. Locked for this run.`
                  : `Stop this run and restart as ${MODE_LABEL[nextMode]} — ${MODE_SUBTITLE[nextMode]}.`
              }
              disabled={active || restartM.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Restart this run as ${MODE_LABEL[nextMode]}?`,
                    description: `Stops the current ${MODE_LABEL[mode]} run and restarts in ${MODE_LABEL[nextMode]} mode.`,
                    primaryLabel: "Restart",
                    variant: "destructive",
                  })
                ) {
                  restartM.mutate({ runId, mode: nextMode });
                }
              }}
              className={cn(
                "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] uppercase tracking-wider transition-colors",
                active
                  ? "bg-ember/10 text-foreground"
                  : "text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50",
              )}
            >
              {restartM.isPending && !active ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <EngagementModeGlyph mode={nextMode} size={11} />
              )}
              {MODE_LABEL[nextMode]}
            </button>
          );
        })}
      </div>
      <span className="text-meta text-muted-foreground">Active mode is locked</span>
      {confirmElement}
    </div>
  );
}

function deriveWorkstreamState(
  run:
    | {
        status: string;
        acknowledgedAt?: Date | string | null;
        outputStartedAt?: Date | string | null;
        lastWakeAt?: Date | string | null;
        lastEventAt: Date | string;
      }
    | null
    | undefined,
  now: number,
  isActiveRun: boolean,
  quietMs: number | null,
): WorkstreamState {
  if (!run) return "assigned";
  const canonical = run.status.toUpperCase();
  if (canonical === "WAITING") return "waiting";
  if (!isActiveRun) {
    if (canonical === "COMPLETED") return "completed";
    if (canonical === "STALLED") return "stalled";
    if (canonical === "ERRORED" || canonical === "FAILED") return "errored";
    if (canonical === "ABANDONED") return "stopped";
  }
  const age = now - new Date(run.lastEventAt).getTime();
  if (quietMs !== null && age >= quietMs) return "quiet";
  if (run.outputStartedAt) return "working";
  if (run.acknowledgedAt) return "acknowledged";
  if (run.lastWakeAt) return "wake-sent";
  return "queued";
}

function stateLabel(state: WorkstreamState): string {
  return {
    assigned: "Assigned",
    queued: "Dispatched",
    "wake-sent": "Wake sent",
    acknowledged: "Acknowledged",
    working: "Working",
    quiet: "Quiet",
    waiting: "Waiting on you",
    completed: "Completed",
    stalled: "Stalled",
    stopped: "Stopped",
    errored: "Errored",
  }[state];
}

function stateCopy(state: WorkstreamState): string {
  return {
    assigned: "Assigned · no active run",
    queued: "Queued for runtime dispatch",
    "wake-sent": "Wake delivered · waiting for acknowledgement",
    acknowledged: "Agent acknowledged · preparing output",
    working: "Agent is working",
    quiet: "No recent runtime signal",
    waiting: "Waiting for your reply",
    completed: "Latest run completed",
    stalled: "Latest run was marked stalled",
    stopped: "Latest run was stopped",
    errored: "Latest run ended with an error",
  }[state];
}

function stateDescription(state: WorkstreamState): string {
  if (state === "quiet") {
    return "This run is still ACTIVE but has not sent a recent signal. Quiet is not the canonical STALLED state.";
  }
  if (state === "stalled") return "The server recorded this run as canonically STALLED.";
  return stateCopy(state);
}

function stateTone(state: WorkstreamState): {
  container: string;
  badge: string;
  dot: string;
} {
  if (state === "working" || state === "acknowledged") {
    return {
      container: "border-ember/30",
      badge: "border-ember/30 bg-ember/10 text-ember",
      dot: "bg-ember",
    };
  }
  if (state === "waiting") {
    return {
      container: "border-warning/30",
      badge: "border-warning/30 bg-warning/10 text-warning",
      dot: "bg-warning",
    };
  }
  if (state === "quiet") {
    return {
      container: "border-warning/20",
      badge: "border-warning/30 bg-warning/10 text-warning",
      dot: "bg-warning",
    };
  }
  if (state === "stalled" || state === "errored") {
    return {
      container: "border-destructive/30",
      badge: "border-destructive/30 bg-destructive/10 text-destructive",
      dot: "bg-destructive",
    };
  }
  if (state === "completed") {
    return {
      container: "border-success/20",
      badge: "border-success/30 bg-success/10 text-success",
      dot: "bg-success",
    };
  }
  return {
    container: "border-border",
    badge: "border-border bg-background/60 text-muted-foreground",
    dot: "bg-muted-foreground",
  };
}

function mergeAgent(
  runAgent: WorkstreamAgent | null,
  assignedAgent: WorkstreamAgent | null,
): WorkstreamAgent | null {
  if (!runAgent) return assignedAgent;
  if (!assignedAgent || runAgent.id !== assignedAgent.id) return runAgent;
  return {
    ...assignedAgent,
    ...runAgent,
    runtime: runAgent.runtime ?? assignedAgent.runtime,
  };
}

function normalizeMode(value: string | null | undefined): EngagementModeValue | null {
  const normalized = value?.toUpperCase();
  return normalized && MODE_ORDER.includes(normalized as EngagementModeValue)
    ? (normalized as EngagementModeValue)
    : null;
}

function providerLabel(provider: string | null | undefined): string | null {
  const normalized = provider?.trim();
  if (!normalized) return null;
  return normalized
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
