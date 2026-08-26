"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Copy,
  LinkIcon,
  PlugZap,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { TransportChip } from "@/components/agents/transport-chip";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { StatusDot } from "@/components/ui/status-dot";
import { ProjectChip } from "@/components/project-chip";
import { presenceAvailability, runtimeDisplayIdentity } from "@/lib/transport-display";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { buildChatDiagnosticReport } from "@/lib/chat-diagnostic-report";
import { useRealtime } from "@/hooks/use-realtime";

/**
 * Right-hand status rail for a chat thread. Surfaces, top to bottom:
 *
 *   - **Connection** — the effective provider, chat engine (runs vs
 *     completions, from `chatReadiness.mode`), the managed runtime backing
 *     it (name + kind), and whether a turn will actually reach a model.
 *     This replaces the old hardcoded "Hermes-backed conversation" copy so a
 *     Claude / Codex / local-daemon thread is described honestly.
 *   - **Reply / Run / Delivery / Context** — operational diagnostics.
 *   - **Actions** — retry dispatch, stop a live runtime run, kick a stale
 *     run, compact, archive/restore, and hard-delete (irreversible).
 *
 * Self-fetches everything it needs from `threadId` + `agentId` so it can be
 * dropped into both the full Chat page (`full`) and Mission Control's Chat
 * tab (`compact`) without the parent threading diagnostics through.
 */

type ContextInfo = {
  contextMode?: string | null;
  summaryMarkdown?: string | null;
  summarizedUntilMessageId?: string | null;
  summarizedAt?: Date | string | null;
};

function duration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function rowTone(ok: boolean | null) {
  if (ok === true) return "border-emerald-500/20 bg-emerald-500/5";
  if (ok === false) return "border-amber-500/30 bg-amber-500/10";
  return "border-border/60 bg-background/60";
}

function runtimeHealthTextClass(tone: string | null | undefined) {
  if (tone === "success") return "text-emerald-600 dark:text-emerald-400";
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function toneClass(tone: string | null | undefined): string {
  if (tone === "success") return "border-emerald-500/20 bg-emerald-500/5";
  if (tone === "danger") return "border-danger/30 bg-danger/10";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10";
  if (tone === "info") return "border-sky-500/25 bg-sky-500/10";
  return "border-border/60 bg-background/60";
}

function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length <= 10 ? id : `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function timelineTime(input: Date | string | null | undefined): string {
  if (!input) return "";
  return new Date(input).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function capabilityLabels(capabilities: Record<string, boolean> | null | undefined) {
  if (!capabilities) return [];
  const labels: Array<[keyof typeof capabilities, string]> = [
    ["streaming", "stream"],
    ["thinking", "thinking"],
    ["tools", "tools"],
    ["approvals", "approvals"],
    ["stop", "stop"],
    ["files", "files"],
    ["vision", "vision"],
    ["runs", "runs"],
    ["dispatch", "dispatch"],
    ["memory", "memory"],
    ["commands", "commands"],
    ["compact", "compact"],
    ["diagnostics", "diagnostics"],
  ];
  return labels.map(([key, label]) => ({
    key: String(key),
    label,
    enabled: Boolean(capabilities[String(key)]),
  }));
}

export function ChatStatusRail({
  workspaceSlug,
  workspaceKey,
  threadId,
  agentId,
  context,
  archived = false,
  variant = "full",
  onDeleted,
}: {
  workspaceSlug: string;
  /**
   * Workspace issue-id prefix (e.g. `AXI`), used to format linked-work ids.
   * Optional — falls back to the workspace context when omitted.
   */
  workspaceKey?: string;
  threadId: string | null;
  agentId: string | null;
  /** Context-policy fields for the Context card (full variant only). */
  context?: ContextInfo | null;
  archived?: boolean;
  variant?: "full" | "compact";
  onDeleted?: () => void;
}) {
  const lastProgressInvalidationRef = useRef(0);
  const utils = trpc.useUtils();
  const ws = useMaybeWorkspace();
  const issuePrefix = workspaceKey ?? ws?.key ?? "";
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: diagnostics } = trpc.chat.threadDiagnostics.useQuery(
    { threadId: threadId ?? "" },
    { enabled: Boolean(threadId), staleTime: 5_000, refetchInterval: 10_000 },
  );
  const { data: agent } = trpc.agent.byId.useQuery(
    { id: agentId ?? "" },
    { enabled: Boolean(agentId), staleTime: 30_000 },
  );
  const { data: readiness } = trpc.chat.chatReadiness.useQuery(
    { agentId: agentId ?? "", threadId: threadId ?? undefined },
    { enabled: Boolean(agentId), staleTime: 30_000 },
  );
  // Human participant — the current operator owns the thread (chat.threads is
  // scoped to userId), so "me" is the human side of every conversation here.
  const { data: me } = trpc.user.me.useQuery(undefined, { staleTime: 60_000 });
  // Linked work is derived honestly from the thread's message contextSnapshots:
  // the most-recent message that carried an `issueId` is the thread's current
  // issue context. We do NOT invent issues — no snapshot id ⇒ no card.
  const { data: thread } = trpc.chat.getThread.useQuery(
    { threadId: threadId ?? "" },
    { enabled: Boolean(threadId), staleTime: 15_000 },
  );
  const linkedIssueId = useMemo(() => {
    // `getThread` selects `contextSnapshot` at runtime, but the shared message
    // type narrows it away — read it through an indexed cast rather than
    // widening the server type (which the threads-list path doesn't select).
    const messages = (thread?.messages ?? []) as Array<{
      contextSnapshot?: { issueId?: unknown } | null;
    }>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const snapshot = messages[i]?.contextSnapshot ?? null;
      const id = snapshot && typeof snapshot.issueId === "string" ? snapshot.issueId : null;
      if (id) return id;
    }
    return null;
  }, [thread?.messages]);
  const { data: linkedIssue } = trpc.issue.byId.useQuery(
    { id: linkedIssueId ?? "" },
    { enabled: Boolean(linkedIssueId), staleTime: 30_000 },
  );

  const invalidate = async () => {
    await utils.chat.threads.invalidate();
    if (threadId) await utils.chat.threadDiagnostics.invalidate({ threadId });
  };

  useRealtime((event) => {
    if (!threadId || event.subjectId !== threadId) return;
    if (
      event.subjectType !== "chat-thread" &&
      event.subjectType !== "chat-thread-stream" &&
      event.subjectType !== "chat-thread-ack" &&
      event.subjectType !== "chat-thread-state"
    ) {
      return;
    }
    if (
      event.subjectType === "chat-thread-stream" &&
      (event.payload as { phase?: unknown } | null)?.phase === "delta"
    ) {
      return;
    }
    if (
      event.subjectType === "chat-thread-state" &&
      (event.payload as { phase?: unknown } | null)?.phase === "progress"
    ) {
      const now = Date.now();
      if (now - lastProgressInvalidationRef.current < 1_500) return;
      lastProgressInvalidationRef.current = now;
    }
    void utils.chat.threadDiagnostics.invalidate({ threadId });
  });

  const retry = trpc.chat.retryLastUserMessage.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const reconnectConnector = trpc.chat.reconnectConnector.useMutation({
    onSuccess: async (result) => {
      toast.success(result.message);
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const stop = trpc.chat.stopThreadRun.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const kick = trpc.chat.kickThreadRun.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const compact = trpc.chat.compactThread.useMutation({
    onSuccess: async () => {
      toast.success("Conversation compacted");
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const archive = trpc.chat.archiveThread.useMutation({
    onSuccess: async () => {
      toast.success("Conversation archived");
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const restore = trpc.chat.restoreThread.useMutation({
    onSuccess: async () => {
      toast.success("Conversation restored");
      await invalidate();
    },
    onError: (err) => toast.error(err.message),
  });
  const remove = trpc.chat.deleteThread.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.stoppedRun ? "Conversation deleted · runtime run stopped" : "Conversation deleted",
      );
      setConfirmDelete(false);
      await invalidate();
      onDeleted?.();
    },
    onError: (err) => toast.error(err.message),
  });

  const engine = readiness?.mode ?? null;
  const effectiveProvider = readiness?.provider ?? agent?.provider ?? null;
  const runtime = agent?.runtime ?? null;
  const runtimeIdentity = runtimeDisplayIdentity({
    adapterKey: runtime?.adapterKey,
    kind: runtime?.kind,
  });
  const runtimeHealth = runtime?.health ?? null;
  const readinessRepeatsProbeFailure =
    readiness?.reason === "runtime-probe-failed" && Boolean(runtimeHealth);
  const connectionOk = readiness
    ? readiness.ready &&
      (!runtimeHealth || runtimeHealth.tone === "success" || runtimeHealth.tone === "muted")
    : null;
  const hasOpenTurn = Boolean(diagnostics?.waitingForReply);
  const runStale = Boolean(
    hasOpenTurn &&
    diagnostics?.lastRun &&
    diagnostics.lastRun.status === "ACTIVE" &&
    diagnostics.lastRun.idleMs >= 60_000,
  );
  const runActive = hasOpenTurn && diagnostics?.lastRun?.status === "ACTIVE";
  const runBad = hasOpenTurn && (diagnostics?.lastRun?.status === "STALLED" || runStale);
  const deliveryBad = hasOpenTurn && diagnostics?.lastDelivery?.status === "FAILED";
  const connectorBad = Boolean(
    diagnostics?.connectorSession &&
    ["ERROR", "DISCONNECTED"].includes(diagnostics.connectorSession.lifecycle),
  );
  const streamBad = Boolean(
    diagnostics?.lastAgentStreamError ||
    (diagnostics?.lastAgentStreamAborted && diagnostics.turnStatus?.phase !== "stopped"),
  );
  const canRetry = Boolean(diagnostics?.waitingForReply || deliveryBad || streamBad);
  const canKick = Boolean(hasOpenTurn && diagnostics?.lastRun?.id && runBad);
  // Stop only makes sense for a runs-backed live session — Forge can ask the
  // managed runtime to terminate it. A completions agent's in-flight turn is
  // stopped from the composer, not here.
  const canStop = Boolean(
    hasOpenTurn && diagnostics?.lastRun?.id && runActive && engine === "runs",
  );
  const capabilityRows = capabilityLabels(readiness?.capabilities);
  const copyDiagnosticId = async (id: string, label: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast.success(`${label} id copied`);
    } catch {
      toast.error("Could not copy id");
    }
  };
  const copyDiagnosticReport = async () => {
    if (!threadId) return;
    try {
      await navigator.clipboard.writeText(
        buildChatDiagnosticReport({
          workspaceSlug,
          threadId,
          generatedAt: new Date(),
          agent,
          runtime,
          readiness,
          diagnostics,
          linkedIssue: linkedIssue
            ? {
                id: linkedIssue.id,
                number: linkedIssue.number,
                status: linkedIssue.status.name,
                title: linkedIssue.title,
              }
            : null,
        }),
      );
      toast.success("Diagnostic report copied");
    } catch {
      toast.error("Could not copy diagnostic report");
    }
  };
  const timelineRows = useMemo(() => {
    const rows: Array<{
      key: string;
      label: string;
      detail: string;
      at?: Date | string | null;
      id?: string | null;
      tone?: "success" | "warning" | "danger" | "muted";
    }> = [];
    if (diagnostics?.latestUserMessage) {
      rows.push({
        key: "message",
        label: "Message",
        detail: "user turn persisted",
        at: diagnostics.latestUserMessage.createdAt,
        id: diagnostics.latestUserMessage.id,
        tone: "success",
      });
      const readAt =
        diagnostics.latestUserMessage.acknowledgedAt ??
        diagnostics.latestUserMessage.outputStartedAt;
      if (readAt) {
        rows.push({
          key: "read",
          label: "Read",
          detail: "agent acknowledged",
          at: readAt,
          id: diagnostics.latestUserMessage.id,
          tone: "success",
        });
      } else if (diagnostics.latestUserMessage.lastWakeAt) {
        rows.push({
          key: "wake",
          label: "Wake",
          detail: `${diagnostics.latestUserMessage.wakeAttempts} attempt${
            diagnostics.latestUserMessage.wakeAttempts === 1 ? "" : "s"
          }`,
          at: diagnostics.latestUserMessage.lastWakeAt,
          id: diagnostics.latestUserMessage.lastWakeDeliveryId,
          tone: diagnostics.dispatchState === "stalled" ? "warning" : "muted",
        });
      }
    }
    if (diagnostics?.lastRun) {
      rows.push({
        key: "run",
        label: "Run",
        detail: `${diagnostics.lastRun.status.toLowerCase()} · ${
          diagnostics.lastRun.currentStep ?? "no current step"
        }`,
        at: diagnostics.lastRun.lastEventAt ?? diagnostics.lastRun.startedAt,
        id: diagnostics.lastRun.id,
        tone: runBad ? "warning" : "success",
      });
    }
    if (diagnostics?.lastDelivery) {
      rows.push({
        key: "delivery",
        label: "Delivery",
        detail: `${diagnostics.lastDelivery.status.toLowerCase()} · ${
          diagnostics.lastDelivery.attempts
        } attempt${diagnostics.lastDelivery.attempts === 1 ? "" : "s"}`,
        at: diagnostics.lastDelivery.updatedAt,
        id: diagnostics.lastDelivery.id,
        tone: deliveryBad ? "danger" : "success",
      });
    }
    return rows;
  }, [deliveryBad, diagnostics, runBad]);

  const compactLayout = variant === "compact";

  if (!threadId || !agentId) {
    return (
      <div className="text-meta rounded-xl border border-border bg-card/50 p-4 text-muted-foreground">
        Select a conversation to inspect its connection, delivery, and run state.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-border bg-card/50",
        compactLayout ? "p-3" : "p-4",
      )}
    >
      {/* Members — the agent + the human operator who owns this thread. Both
          identities are known from thread/workspace context; nothing fabricated. */}
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Users className="h-3.5 w-3.5 text-muted-foreground" /> Members
        </div>
        <ul className="mt-2 flex flex-col gap-0.5">
          {agent && (
            <li className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-subtle/60">
              <AgentPresenceDot
                status={agent.status}
                size="md"
                availability={presenceAvailability(agent)}
                lastHeartbeatAt={agent.lastHeartbeatAt}
              />
              <Link
                href={`/w/${workspaceSlug}/agents/${agent.profileKey}`}
                className="text-id truncate font-mono text-foreground/90 hover:text-foreground"
              >
                @{agent.profileKey}
              </Link>
              <span className="ml-auto rounded border border-ember/30 bg-ember/10 px-1 py-0 text-[0.625rem] uppercase tracking-wider text-ember">
                {(agent.role ?? "agent").toLowerCase()}
              </span>
            </li>
          )}
          {me && (
            <li className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-subtle/60">
              {me.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={me.image} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-subtle text-[0.625rem] text-muted-foreground">
                  {(me.name ?? me.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="truncate text-sm text-foreground">
                {me.name ?? me.email ?? "You"}
              </span>
              <span className="text-meta ml-auto text-muted-foreground">you</span>
            </li>
          )}
        </ul>
      </div>

      {/* Linked work — derived from the thread's message contextSnapshots. Only
          rendered when a snapshot actually carried an issue id; otherwise a quiet
          empty state. No invented issues. */}
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <LinkIcon className="h-3.5 w-3.5 text-muted-foreground" /> Linked work
        </div>
        {linkedIssue ? (
          // Not a single wrapping anchor — ProjectChip renders its own link, so
          // the card is a div and the issue id carries the issue link (no
          // nested <a>, which is invalid HTML).
          <div className="mt-2 rounded-md border border-border bg-card/40 p-2 transition-colors hover:border-border">
            <div className="text-meta flex items-center gap-1.5 text-muted-foreground">
              <StatusDot status={linkedIssue.status} />
              <Link
                href={`/w/${workspaceSlug}/issues/${linkedIssue.id}`}
                className="text-id font-mono text-foreground/90 hover:text-foreground"
              >
                {formatIssueId(issuePrefix, linkedIssue.number)}
              </Link>
              {linkedIssue.project && (
                <ProjectChip
                  project={linkedIssue.project}
                  slug={workspaceSlug}
                  className="ml-auto px-1 py-0.5"
                />
              )}
            </div>
            <Link
              href={`/w/${workspaceSlug}/issues/${linkedIssue.id}`}
              className="mt-1 line-clamp-2 block text-sm text-foreground hover:text-ember"
            >
              {linkedIssue.title}
            </Link>
          </div>
        ) : (
          <p className="text-meta mt-2 rounded-md border border-dashed border-border/60 bg-background/40 px-2 py-1.5 text-muted-foreground">
            No linked work for this conversation.
          </p>
        )}
      </div>

      <div className="border-t border-border/60 pt-3">
        <div className="text-sm font-semibold text-foreground">Status</div>
        <p className="text-meta mt-1 text-muted-foreground">
          Connection and operational state for this conversation.
        </p>
      </div>

      {/* Connection — provider · engine · runtime · readiness. */}
      <div className={cn("text-meta rounded-lg border p-2", rowTone(connectionOk))}>
        <div className="flex items-center gap-2 font-medium text-foreground">
          <PlugZap className="h-3.5 w-3.5" /> Connection
        </div>
        <div className="mt-1 space-y-1 text-muted-foreground">
          <div className="flex flex-wrap items-center gap-1">
            <span className="rounded border border-border bg-background/60 px-1 py-0 text-[0.625rem] uppercase tracking-wider text-foreground/80">
              {effectiveProvider ?? "—"}
            </span>
            {readiness && (
              <TransportChip mode={readiness.mode} label={readiness.transportLabel} showNone />
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Server className="h-3 w-3 shrink-0" />
            {runtime ? (
              <span>
                <Link
                  href={
                    runtime.id
                      ? `/w/${workspaceSlug}/settings/runtimes/${runtime.id}`
                      : `/w/${workspaceSlug}/settings/runtimes`
                  }
                  className="underline decoration-dotted hover:text-foreground"
                >
                  {runtime.name}
                </Link>{" "}
                · {runtimeIdentity.runtimeLabel} · {runtimeIdentity.transportLabel}
              </span>
            ) : (
              <span className="italic text-muted-foreground/80">no managed runtime attached</span>
            )}
          </div>
          {runtimeHealth && (
            <div
              className={cn(
                "flex items-start gap-1.5 text-[0.625rem]",
                runtimeHealthTextClass(runtimeHealth.tone),
              )}
            >
              {runtimeHealth.tone === "success" ? (
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              <span className="line-clamp-3">
                {runtimeHealth.label} · {runtimeHealth.reason}
              </span>
            </div>
          )}
          {readiness && !readiness.ready && !readinessRepeatsProbeFailure && (
            <div className="flex items-start gap-1.5 text-[0.625rem] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="line-clamp-3">{readiness.hint}</span>
            </div>
          )}
          {readiness?.ready && (
            <div className="flex items-center gap-1.5 text-[0.625rem] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> chat reaches a model
            </div>
          )}
          {capabilityRows.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {capabilityRows.map((cap) => (
                <span
                  key={cap.key}
                  className={cn(
                    "rounded border px-1 py-0 text-[0.5625rem] uppercase tracking-wider",
                    cap.enabled
                      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : "border-border/50 bg-subtle/30 text-muted-foreground/55",
                  )}
                  title={cap.enabled ? `${cap.label} supported` : `${cap.label} unavailable`}
                >
                  {cap.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {diagnostics?.connectorSession && (
        <div
          className={cn(
            "text-meta rounded-lg border p-2",
            rowTone(connectorBad ? false : diagnostics.connectorSession.lifecycle === "ACTIVE"),
          )}
        >
          <div className="flex items-center justify-between gap-2 font-medium text-foreground">
            <span className="flex items-center gap-2">
              <PlugZap className="h-3.5 w-3.5" /> Hermes session
            </span>
            <span className="rounded bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase">
              {diagnostics.connectorSession.lifecycle.toLowerCase()}
            </span>
          </div>
          <div className="mt-1 space-y-1 text-muted-foreground">
            <button
              type="button"
              className="block max-w-full truncate font-mono hover:text-foreground"
              title={diagnostics.connectorSession.externalSessionId}
              onClick={() =>
                void copyDiagnosticId(
                  diagnostics.connectorSession!.externalSessionId,
                  "Hermes session",
                )
              }
            >
              session · {diagnostics.connectorSession.externalSessionId}
            </button>
            <button
              type="button"
              className="block max-w-full truncate font-mono hover:text-foreground"
              title={diagnostics.connectorSession.id}
              onClick={() =>
                void copyDiagnosticId(diagnostics.connectorSession!.id, "Connector mapping")
              }
            >
              mapping · {diagnostics.connectorSession.id}
            </button>
            <div>
              protocol · {diagnostics.connectorSession.protocolVersion ?? "not negotiated"} · class
              · {diagnostics.connectorSession.sessionClass.toLowerCase()}
            </div>
            <div>
              ownership · {diagnostics.connectorSession.ownership.toLowerCase()} · retries ·{" "}
              {diagnostics.connectorSession.retryCount}
            </div>
            {diagnostics.connectorSession.lastConnectorDelivery && (
              <div>
                last event · {diagnostics.connectorSession.lastConnectorDelivery.kind} ·{" "}
                {diagnostics.connectorSession.lastConnectorDelivery.status.toLowerCase()} · attempt{" "}
                {diagnostics.connectorSession.lastConnectorDelivery.attempt}
              </div>
            )}
            {diagnostics.connectorSession.capabilities && (
              <div className="flex flex-wrap gap-1 pt-1">
                {Object.entries(
                  diagnostics.connectorSession.capabilities as Record<string, unknown>,
                )
                  .filter(([, enabled]) => enabled === true)
                  .slice(0, 8)
                  .map(([capability]) => (
                    <span
                      key={capability}
                      className="rounded bg-card/40 px-1.5 py-0.5 text-[0.625rem]"
                    >
                      {capability}
                    </span>
                  ))}
              </div>
            )}
          </div>
          {diagnostics.connectorSession.lastError && (
            <div className="mt-1 line-clamp-3 text-[0.625rem] text-amber-600 dark:text-amber-400">
              {diagnostics.connectorSession.lastError}
            </div>
          )}
          <Button
            variant="subtle"
            size="sm"
            className="mt-2 w-full justify-start"
            disabled={reconnectConnector.isPending}
            onClick={() => reconnectConnector.mutate({ threadId })}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Reconnect &amp; renegotiate
          </Button>
        </div>
      )}

      <div
        className={cn("text-meta rounded-lg border p-2", toneClass(diagnostics?.turnStatus?.tone))}
      >
        <div className="flex items-center gap-2 font-medium text-foreground">
          {diagnostics?.turnStatus?.tone === "danger" ||
          diagnostics?.turnStatus?.tone === "warning" ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Turn
          {diagnostics?.turnStatus?.phase && (
            <span className="ml-auto rounded border border-border/60 bg-background/50 px-1 py-0 font-mono text-[0.5625rem] uppercase tracking-wider text-muted-foreground">
              {diagnostics.turnStatus.phase}
            </span>
          )}
        </div>
        <div className="mt-1 text-muted-foreground">
          {diagnostics?.turnStatus?.label ?? "Ready"}
          {diagnostics?.turnStatus?.waitingMs != null &&
            ` · ${duration(diagnostics.turnStatus.waitingMs)}`}
        </div>
        {diagnostics?.turnStatus?.detail && (
          <div className="mt-1 line-clamp-3 text-[0.625rem] text-muted-foreground/80">
            {diagnostics.turnStatus.detail}
          </div>
        )}
      </div>

      {timelineRows.length > 0 && (
        <div className="text-meta rounded-lg border border-border/60 bg-background/60 p-2">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5" /> Timeline
          </div>
          <div className="mt-2 space-y-1.5">
            {timelineRows.map((row) => (
              <div key={row.key} className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                    row.tone === "danger"
                      ? "bg-danger"
                      : row.tone === "warning"
                        ? "bg-amber-500"
                        : row.tone === "success"
                          ? "bg-emerald-500"
                          : "bg-muted-foreground/40",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[0.625rem] font-medium text-foreground">{row.label}</span>
                    {row.at && (
                      <span className="text-[0.5625rem] text-muted-foreground/70">
                        {timelineTime(row.at)}
                      </span>
                    )}
                    {row.id && (
                      <button
                        type="button"
                        onClick={() => void copyDiagnosticId(row.id!, row.label)}
                        className="ml-auto inline-flex items-center gap-1 rounded border border-border/50 bg-card/40 px-1 py-0 font-mono text-[0.5625rem] text-muted-foreground hover:border-ember/40 hover:text-foreground"
                        title={`Copy ${row.label.toLowerCase()} id`}
                      >
                        <Copy className="h-2.5 w-2.5" />
                        {shortId(row.id)}
                      </button>
                    )}
                  </div>
                  <div className="truncate text-[0.625rem] text-muted-foreground">{row.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          "text-meta rounded-lg border p-2",
          rowTone(
            agent
              ? presenceAvailability(agent) === "on-demand" || agent.status !== "OFFLINE"
              : null,
          ),
        )}
      >
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Radio className="h-3.5 w-3.5" /> Agent
        </div>
        <div className="mt-1 text-muted-foreground">
          {agent
            ? presenceAvailability(agent) === "on-demand"
              ? "on-demand"
              : agent.status.toLowerCase()
            : "offline"}{" "}
          ·{" "}
          {agent && (
            <Link
              className="underline decoration-dotted"
              href={`/w/${workspaceSlug}/agents/${agent.profileKey}`}
            >
              @{agent.profileKey}
            </Link>
          )}
        </div>
      </div>

      <div
        className={cn(
          "text-meta rounded-lg border p-2",
          rowTone(diagnostics ? !diagnostics.waitingForReply && !streamBad : null),
        )}
      >
        <div className="flex items-center gap-2 font-medium text-foreground">
          {diagnostics?.waitingForReply || streamBad ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Reply
        </div>
        <div className="mt-1 text-muted-foreground">
          {diagnostics?.waitingForReply
            ? `Waiting ${duration(diagnostics.waitingMs)}`
            : "No unreplied user message"}
        </div>
        {diagnostics?.lastAgentStreamError && (
          <div className="mt-1 line-clamp-3 text-[0.625rem] text-amber-600 dark:text-amber-400">
            {diagnostics.lastAgentStreamError}
          </div>
        )}
        {!diagnostics?.lastAgentStreamError &&
          diagnostics?.lastAgentStreamAborted &&
          diagnostics.turnStatus?.phase !== "stopped" && (
            <div className="mt-1 line-clamp-2 text-[0.625rem] text-amber-600 dark:text-amber-400">
              Last reply stream was interrupted before completion.
            </div>
          )}
      </div>

      <div
        className={cn(
          "text-meta rounded-lg border p-2",
          rowTone(diagnostics?.lastRun && hasOpenTurn ? !runBad : null),
        )}
      >
        <div className="flex items-center gap-2 font-medium text-foreground">
          <ShieldAlert className="h-3.5 w-3.5" /> Run
        </div>
        <div className="mt-1 text-muted-foreground">
          {diagnostics?.lastRun
            ? `${diagnostics.lastRun.status.toLowerCase()} · ${diagnostics.lastRun.currentStep ?? "no current step"} · idle ${duration(diagnostics.lastRun.idleMs)}`
            : "No linked run"}
        </div>
      </div>

      {!compactLayout && (
        <div
          className={cn(
            "text-meta rounded-lg border p-2",
            rowTone(diagnostics?.lastDelivery && hasOpenTurn ? !deliveryBad : null),
          )}
        >
          <div className="flex items-center gap-2 font-medium text-foreground">
            <RefreshCw className="h-3.5 w-3.5" /> Delivery
          </div>
          <div className="mt-1 text-muted-foreground">
            {diagnostics?.lastDelivery
              ? `${diagnostics.lastDelivery.status.toLowerCase()} · attempts ${diagnostics.lastDelivery.attempts}`
              : "No webhook delivery linked"}
          </div>
          {diagnostics?.lastDelivery?.lastError && (
            <div className="mt-1 line-clamp-2 text-[0.625rem] text-amber-600 dark:text-amber-400">
              {diagnostics.lastDelivery.lastError}
            </div>
          )}
        </div>
      )}

      {!compactLayout && context && (
        <div className="text-meta rounded-lg border border-border/60 bg-background/60 p-2">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5" /> Context
          </div>
          <div className="mt-1 space-y-1 text-muted-foreground">
            <div>mode · {(context.contextMode ?? "SMART").toLowerCase().replaceAll("_", " ")}</div>
            <div>
              summary ·{" "}
              {context.summaryMarkdown
                ? `through ${context.summarizedUntilMessageId ?? "latest compacted message"}`
                : "not compacted"}
            </div>
            {context.summarizedAt && (
              <div>compacted · {new Date(context.summarizedAt).toLocaleString()}</div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-border/60 pt-3">
        <Button
          variant="subtle"
          size="sm"
          className="w-full justify-start"
          onClick={() => void copyDiagnosticReport()}
        >
          <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy diagnostic report
        </Button>
        <Button
          variant="subtle"
          size="sm"
          className="w-full justify-start"
          disabled={!canRetry || retry.isPending}
          onClick={() => retry.mutate({ threadId })}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry dispatch
        </Button>
        {canStop && (
          <Button
            variant="subtle"
            size="sm"
            className="w-full justify-start"
            disabled={stop.isPending || !diagnostics?.lastRun?.id}
            onClick={() =>
              diagnostics?.lastRun?.id && stop.mutate({ threadId, runId: diagnostics.lastRun.id })
            }
          >
            <Square className="mr-1.5 h-3.5 w-3.5" /> Stop run
          </Button>
        )}
        <Button
          variant="subtle"
          size="sm"
          className="w-full justify-start"
          disabled={!canKick || kick.isPending || !diagnostics?.lastRun?.id}
          onClick={() =>
            diagnostics?.lastRun?.id && kick.mutate({ threadId, runId: diagnostics.lastRun.id })
          }
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Kick run
        </Button>
        <Button
          variant="subtle"
          size="sm"
          className="w-full justify-start"
          disabled={compact.isPending}
          onClick={() => compact.mutate({ threadId })}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Compact now
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          disabled={archive.isPending || restore.isPending}
          onClick={() => (archived ? restore.mutate({ threadId }) : archive.mutate({ threadId }))}
        >
          <CircleSlash className="mr-1.5 h-3.5 w-3.5" />
          {archived ? "Restore conversation" : "Archive conversation"}
        </Button>

        {/* Hard delete — two-click confirm; irreversible. */}
        {confirmDelete ? (
          <div className="space-y-1.5 rounded-lg border border-danger/40 bg-danger/5 p-2">
            <p className="text-[0.6875rem] text-danger">
              Permanently delete this conversation, its messages, and attachments?
              {canStop ? " The live runtime run will be stopped." : ""} This can&apos;t be undone.
            </p>
            <div className="flex items-center gap-1.5">
              <Button
                variant="danger"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ threadId })}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-danger hover:text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete conversation
          </Button>
        )}
      </div>
    </div>
  );
}
