"use client";
import { useEffect, useState } from "react";
import { AlertTriangle, Bot, Activity, Hourglass, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  EngagementModeGlyph,
  MODE_LABEL,
  MODE_ORDER,
  MODE_SUBTITLE,
  type EngagementModeValue,
} from "@/components/ui/engagement-mode-glyph";
import { useConfirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { useRealtime } from "@/hooks/use-realtime";
import { relativeTime, cn } from "@/lib/utils";
import { RuntimePolicyBadges } from "@/components/runtime-tool-surface";
import type { RuntimePolicySnapshot } from "@/lib/runtime-enforcement";

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
 *
 * Since the durable inbox refactor the strip also distinguishes
 * canonical dispatch states (queued / wake-sent / acknowledged /
 * running / stalled) using `acknowledgedAt`, `outputStartedAt`,
 * `lastWakeAt`, and the legacy `lastEventAt` falloff. Webhook delivery
 * success no longer implies the agent is doing work — the agent must
 * have acked the run for the strip to show "running".
 */
export function AgentRunStrip({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils();
  const { data: run } = trpc.agentRun.activeForIssue.useQuery({ issueId }, { staleTime: 5_000 });
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
  // WAITING short-circuits the wake/ack derivation entirely — when the
  // agent has self-blocked, the operator's eye should land on "this is
  // on you" rather than on the wake-state machine.
  const state: StripState =
    run.status === "WAITING"
      ? "waiting"
      : deriveStripState({
          acknowledgedAt: run.acknowledgedAt,
          outputStartedAt: run.outputStartedAt,
          lastWakeAt: run.lastWakeAt,
          lastEventAt: new Date(run.lastEventAt),
          now,
        });
  const step =
    state === "idle"
      ? run.currentStep
        ? `${run.currentStep} · idle`
        : "idle"
      : (run.currentStep ??
        (state === "waiting"
          ? "Waiting on you"
          : state === "running"
            ? "working…"
            : state === "acknowledged"
              ? "acknowledged · drafting…"
              : state === "wake-sent"
                ? `wake sent · waiting for ack${run.wakeAttempts > 1 ? ` (${run.wakeAttempts} attempts)` : ""}`
                : state === "queued"
                  ? "queued · waking…"
                  : "no activity"));

  return (
    <div
      className={cn(
        "mb-3 flex min-w-0 flex-col gap-2 overflow-hidden rounded-md border px-3 py-2 text-[0.75rem]",
        state === "running"
          ? "border-ember/30 bg-ember/5"
          : state === "acknowledged"
            ? "border-ember/20 bg-ember/5"
            : state === "waiting"
              ? "border-ember/40 bg-ember/10"
              : state === "stalled"
                ? "border-amber-500/30 bg-amber-500/5"
                : "border-border bg-card/40",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="relative flex h-2 w-2 shrink-0">
          {state === "running" || state === "acknowledged" ? (
            // Live pulse only while events are still arriving. Once the
            // agent's final turn lands (no events past the live window) the
            // state settles to "idle" — a calm static dot, no ping — so the
            // strip stops claiming active work the moment it's done.
            <>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ember opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
            </>
          ) : state === "waiting" ? (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ember" />
          ) : state === "idle" ? (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ember/60" />
          ) : state === "stalled" ? (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          ) : (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/60" />
          )}
        </span>
        {state === "waiting" ? (
          <Hourglass className="h-3.5 w-3.5 shrink-0 text-ember" />
        ) : (
          <Bot
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              state === "stalled" ? "text-amber-600 dark:text-amber-300" : "text-ember",
            )}
          />
        )}
        <span className="shrink-0 font-medium">{run.agent.name}</span>
        {state === "waiting" && (
          // Soft "Waiting on you" pill in the warm ember tone — distinct
          // from the alarming amber STALLED pill so patient agents read
          // as "your turn" not "broken."
          <span className="shrink-0 rounded-sm border border-ember/40 bg-ember/10 px-1.5 py-px text-[0.625rem] font-semibold uppercase tracking-wider text-ember">
            Waiting on you
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">·</span>
        <span
          className="min-w-0 basis-full truncate text-foreground/80 sm:flex-1 sm:basis-auto"
          title={step}
        >
          {step}
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,auto)_minmax(0,1fr)] lg:items-start">
        <RunModeControl
          issueId={issueId}
          runId={run.id}
          mode={run.engagementMode as EngagementModeValue}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
          <RuntimePolicyBadges
            compact
            policy={run.runtimePolicy as RuntimePolicySnapshot | null | undefined}
          />
          <ProtocolDiagnostics
            diagnostics={
              run.protocolDiagnostics as
                | Array<{ code: string; severity: string; title: string; description: string }>
                | undefined
            }
          />
          <span className="text-meta flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <Activity className="h-3 w-3 shrink-0" />
            <span
              className="shrink-0"
              title={`Started ${new Date(run.startedAt).toLocaleString()}`}
            >
              {elapsedLabel}
            </span>
            <span className="shrink-0">·</span>
            <span
              className="shrink-0"
              title={`Last event ${new Date(run.lastEventAt).toLocaleString()}`}
            >
              updated {lastEventLabel}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function ProtocolDiagnostics({
  diagnostics,
}: {
  diagnostics?: Array<{ code: string; severity: string; title: string; description: string }>;
}) {
  const actionable = diagnostics?.filter((d) => d.severity !== "info") ?? [];
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
    onSuccess: (res) => {
      void utils.agentRun.activeForIssue.invalidate({ issueId });
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.recentTerminal.invalidate();
      void utils.issue.byId.invalidate({ id: issueId });
      if (res.restarted)
        toast.success(`Restarted as ${MODE_LABEL[res.mode as EngagementModeValue]}`);
      else toast.message("Run already uses that mode");
    },
    onError: (err) => toast.error(err.message),
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-meta shrink-0 text-muted-foreground">restart as</span>
      <div
        role="group"
        aria-label="Run engagement mode"
        title="Mode is fixed per run. Pick another mode to stop this run and restart with that contract."
        className="flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-md border border-border bg-background/80 p-0.5"
      >
        {MODE_ORDER.map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              aria-label={
                active
                  ? `Current run mode ${MODE_LABEL[m]}`
                  : `Stop current run and restart as ${MODE_LABEL[m]}`
              }
              title={
                active
                  ? `${MODE_LABEL[m]} — ${MODE_SUBTITLE[m]}. Locked for this run.`
                  : `Stop this run and restart as ${MODE_LABEL[m]} — ${MODE_SUBTITLE[m]}.`
              }
              disabled={active || restartM.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Restart this run as ${MODE_LABEL[m]}?`,
                    description: `Stops the current ${MODE_LABEL[mode]} run and restarts in ${MODE_LABEL[m]} mode.`,
                    primaryLabel: "Restart",
                    variant: "destructive",
                  })
                )
                  restartM.mutate({ runId, mode: m });
              }}
              className={cn(
                "focus-ring inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[0.625rem] uppercase tracking-wider transition-colors",
                active
                  ? "bg-ember/10 text-foreground"
                  : "text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-50",
              )}
              data-run-id={runId}
            >
              {restartM.isPending && !active ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <EngagementModeGlyph mode={m} size={11} />
              )}
              <span>{MODE_LABEL[m]}</span>
            </button>
          );
        })}
      </div>
      <span
        className="text-meta shrink-0 text-muted-foreground"
        title="Active mode is fixed for this run. Other modes stop and restart."
      >
        active mode locked
      </span>
      {confirmElement}
    </div>
  );
}

type StripState =
  | "queued"
  | "wake-sent"
  | "acknowledged"
  | "running"
  | "idle"
  | "stalled"
  | "waiting";

function deriveStripState(input: {
  acknowledgedAt: Date | string | null;
  outputStartedAt: Date | string | null;
  lastWakeAt: Date | string | null;
  lastEventAt: Date;
  now: number;
}): Exclude<StripState, "waiting"> {
  // Live window: how recently an event must have arrived to still read as
  // actively "running" (pulsing). Past this — but before the stale cutoff
  // — the run has settled (its final turn landed) and shows a calm "idle"
  // state instead of claiming ongoing work.
  const LIVE_MS = 90_000;
  const STALE_MS = 5 * 60_000;
  if (input.outputStartedAt) {
    const idleMs = input.now - input.lastEventAt.getTime();
    if (idleMs > STALE_MS) return "stalled";
    return idleMs > LIVE_MS ? "idle" : "running";
  }
  if (input.acknowledgedAt) {
    return input.now - input.lastEventAt.getTime() > STALE_MS ? "stalled" : "acknowledged";
  }
  if (input.lastWakeAt) {
    const wake = new Date(input.lastWakeAt).getTime();
    return input.now - wake > STALE_MS ? "stalled" : "wake-sent";
  }
  return "queued";
}

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
