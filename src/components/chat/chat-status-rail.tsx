"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, Radio, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Diagnostics = {
  waitingForReply: boolean;
  waitingMs: number | null;
  lastRun: null | {
    id: string;
    status: string;
    currentStep: string | null;
    idleMs: number;
  };
  lastDelivery: null | {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
  };
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

export function ChatStatusRail({
  workspaceSlug,
  thread,
}: {
  workspaceSlug: string;
  thread: {
    id: string;
    agent: { id: string; name: string; profileKey: string; status: string; role?: string | null };
    diagnostics?: Diagnostics | null;
  } | null;
}) {
  const utils = trpc.useUtils();
  const retry = trpc.chat.retryLastUserMessage.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      await utils.chat.threads.invalidate();
      if (thread?.id) await utils.chat.threadDiagnostics.invalidate({ threadId: thread.id });
    },
    onError: (err) => toast.error(err.message),
  });
  const kick = trpc.chat.kickThreadRun.useMutation({
    onSuccess: async (result) => {
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      await utils.chat.threads.invalidate();
      if (thread?.id) await utils.chat.threadDiagnostics.invalidate({ threadId: thread.id });
    },
    onError: (err) => toast.error(err.message),
  });

  if (!thread) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-4 text-meta text-muted-foreground">
        Select a conversation to inspect delivery and run state.
      </div>
    );
  }

  const diagnostics = thread.diagnostics;
  const runStale = Boolean(diagnostics?.lastRun && diagnostics.lastRun.status === "ACTIVE" && diagnostics.lastRun.idleMs >= 60_000);
  const runBad = diagnostics?.lastRun?.status === "STALLED" || runStale;
  const deliveryBad = diagnostics?.lastDelivery?.status === "FAILED";
  const canRetry = Boolean(diagnostics?.waitingForReply || deliveryBad);
  const canKick = Boolean(diagnostics?.lastRun?.id && runBad);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
      <div>
        <div className="text-sm font-semibold text-foreground">Status</div>
        <p className="mt-1 text-meta text-muted-foreground">Operational state for this Hermes-backed conversation.</p>
      </div>

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(thread.agent.status !== "OFFLINE"))}>
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Radio className="h-3.5 w-3.5" /> Agent
        </div>
        <div className="mt-1 text-muted-foreground">
          {thread.agent.status.toLowerCase()} · <Link className="underline decoration-dotted" href={`/w/${workspaceSlug}/agents/${thread.agent.profileKey}`}>@{thread.agent.profileKey}</Link>
        </div>
      </div>

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(!diagnostics?.waitingForReply))}>
        <div className="flex items-center gap-2 font-medium text-foreground">
          {diagnostics?.waitingForReply ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Reply
        </div>
        <div className="mt-1 text-muted-foreground">
          {diagnostics?.waitingForReply ? `Waiting ${duration(diagnostics.waitingMs)}` : "No unreplied user message"}
        </div>
      </div>

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(diagnostics?.lastRun ? !runBad : null))}>
        <div className="flex items-center gap-2 font-medium text-foreground"><ShieldAlert className="h-3.5 w-3.5" /> Run</div>
        <div className="mt-1 text-muted-foreground">
          {diagnostics?.lastRun ? `${diagnostics.lastRun.status.toLowerCase()} · ${diagnostics.lastRun.currentStep ?? "no current step"} · idle ${duration(diagnostics.lastRun.idleMs)}` : "No linked run"}
        </div>
      </div>

      <div className={cn("rounded-lg border p-2 text-meta", rowTone(diagnostics?.lastDelivery ? !deliveryBad : null))}>
        <div className="flex items-center gap-2 font-medium text-foreground"><RefreshCw className="h-3.5 w-3.5" /> Delivery</div>
        <div className="mt-1 text-muted-foreground">
          {diagnostics?.lastDelivery ? `${diagnostics.lastDelivery.status.toLowerCase()} · attempts ${diagnostics.lastDelivery.attempts}` : "No webhook delivery linked"}
        </div>
        {diagnostics?.lastDelivery?.lastError && <div className="mt-1 line-clamp-2 text-[0.625rem] text-amber-600 dark:text-amber-400">{diagnostics.lastDelivery.lastError}</div>}
      </div>

      <div className="space-y-2 border-t border-border/60 pt-3">
        <Button variant="subtle" size="sm" className="w-full justify-start" disabled={!canRetry || retry.isPending} onClick={() => retry.mutate({ threadId: thread.id })}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry dispatch
        </Button>
        <Button variant="subtle" size="sm" className="w-full justify-start" disabled={!canKick || kick.isPending || !diagnostics?.lastRun?.id} onClick={() => diagnostics?.lastRun?.id && kick.mutate({ threadId: thread.id, runId: diagnostics.lastRun.id })}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Kick run
        </Button>
      </div>
    </div>
  );
}
