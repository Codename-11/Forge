"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  PlugZap,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { TransportChip } from "@/components/agents/transport-chip";

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

function runtimeKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "LOCAL_DAEMON":
      return "local daemon";
    case "REMOTE_HTTP":
      return "remote http";
    case "CLOUD":
      return "cloud";
    default:
      return (kind ?? "runtime").toLowerCase();
  }
}

export function ChatStatusRail({
  workspaceSlug,
  threadId,
  agentId,
  context,
  archived = false,
  variant = "full",
  onDeleted,
}: {
  workspaceSlug: string;
  threadId: string | null;
  agentId: string | null;
  /** Context-policy fields for the Context card (full variant only). */
  context?: ContextInfo | null;
  archived?: boolean;
  variant?: "full" | "compact";
  onDeleted?: () => void;
}) {
  const utils = trpc.useUtils();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: diagnostics } = trpc.chat.threadDiagnostics.useQuery(
    { threadId: threadId ?? "" },
    { enabled: Boolean(threadId), staleTime: 10_000 },
  );
  const { data: agent } = trpc.agent.byId.useQuery(
    { id: agentId ?? "" },
    { enabled: Boolean(agentId), staleTime: 30_000 },
  );
  const { data: readiness } = trpc.chat.chatReadiness.useQuery(
    { agentId: agentId ?? "", threadId: threadId ?? undefined },
    { enabled: Boolean(agentId), staleTime: 30_000 },
  );

  const invalidate = async () => {
    await utils.chat.threads.invalidate();
    if (threadId) await utils.chat.threadDiagnostics.invalidate({ threadId });
  };

  const retry = trpc.chat.retryLastUserMessage.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
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
        result.stoppedRun
          ? "Conversation deleted · runtime run stopped"
          : "Conversation deleted",
      );
      setConfirmDelete(false);
      await invalidate();
      onDeleted?.();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!threadId || !agentId) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-4 text-meta text-muted-foreground">
        Select a conversation to inspect its connection, delivery, and run state.
      </div>
    );
  }

  const engine = readiness?.mode ?? null; // "runs" | "completions"
  const effectiveProvider = readiness?.provider ?? agent?.provider ?? null;
  const runtime = agent?.runtime ?? null;
  const runStale = Boolean(
    diagnostics?.lastRun &&
      diagnostics.lastRun.status === "ACTIVE" &&
      diagnostics.lastRun.idleMs >= 60_000,
  );
  const runActive = diagnostics?.lastRun?.status === "ACTIVE";
  const runBad = diagnostics?.lastRun?.status === "STALLED" || runStale;
  const deliveryBad = diagnostics?.lastDelivery?.status === "FAILED";
  const canRetry = Boolean(diagnostics?.waitingForReply || deliveryBad);
  const canKick = Boolean(diagnostics?.lastRun?.id && runBad);
  // Stop only makes sense for a runs-backed live session — Forge can ask the
  // managed runtime to terminate it. A completions agent's in-flight turn is
  // stopped from the composer, not here.
  const canStop = Boolean(diagnostics?.lastRun?.id && runActive && engine === "runs");

  const compactLayout = variant === "compact";

  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border border-border bg-card/50",
        compactLayout ? "p-3" : "p-4",
      )}
    >
      <div>
        <div className="text-sm font-semibold text-foreground">Status</div>
        <p className="mt-1 text-meta text-muted-foreground">
          Connection and operational state for this conversation.
        </p>
      </div>

      {/* Connection — provider · engine · runtime · readiness. */}
      <div className={cn("rounded-lg border p-2 text-meta", rowTone(readiness ? readiness.ready : null))}>
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
                  href={`/w/${workspaceSlug}/settings/runtimes`}
                  className="underline decoration-dotted hover:text-foreground"
                >
                  {runtime.name}
                </Link>{" "}
                · {runtimeKindLabel(runtime.kind)}
              </span>
            ) : (
              <span className="italic text-muted-foreground/80">no managed runtime attached</span>
            )}
          </div>
          {readiness && !readiness.ready && (
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
        </div>
      </div>

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(agent ? agent.status !== "OFFLINE" : null))}>
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Radio className="h-3.5 w-3.5" /> Agent
        </div>
        <div className="mt-1 text-muted-foreground">
          {(agent?.status ?? "offline").toLowerCase()} ·{" "}
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

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(!diagnostics?.waitingForReply))}>
        <div className="flex items-center gap-2 font-medium text-foreground">
          {diagnostics?.waitingForReply ? (
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
      </div>

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(diagnostics?.lastRun ? !runBad : null))}>
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
        <div className={cn("rounded-lg border p-2 text-meta", rowTone(diagnostics?.lastDelivery ? !deliveryBad : null))}>
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
        <div className="rounded-lg border border-border/60 bg-background/60 p-2 text-meta">
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
              diagnostics?.lastRun?.id &&
              stop.mutate({ threadId, runId: diagnostics.lastRun.id })
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
            diagnostics?.lastRun?.id &&
            kick.mutate({ threadId, runId: diagnostics.lastRun.id })
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
          onClick={() =>
            archived ? restore.mutate({ threadId }) : archive.mutate({ threadId })
          }
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
