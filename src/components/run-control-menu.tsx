"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  MoreHorizontal,
  PauseCircle,
  Shuffle,
  StopCircle,
} from "lucide-react";
import type {
  AgentRunControlState,
  AgentRunStatus,
} from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * `RunControlMenu` — small icon button that exposes Pause / Cancel /
 * Redirect-to-… on an active AgentRun. The menu disables actions whose
 * signal is already pending (so PAUSE_REQUESTED greys the Pause entry
 * but leaves Cancel / Redirect available). Each item fires the matching
 * tRPC mutation and surfaces an optimistic toast.
 *
 * Visual idiom mirrors `AgentQuickActions`: 6×6 trigger, 11rem-wide
 * popover, click-outside + Escape close. Redirect opens an inline
 * agent-picker submenu populated from `agent.list`.
 *
 * Terminal runs (COMPLETED / ABANDONED / STALLED) render a disabled
 * trigger — there's no live runtime to control. Phase 1 callers should
 * wrap this in a parent that conditionally renders it only on ACTIVE
 * runs to avoid the dim affordance.
 */
export type RunControlMenuRun = {
  id: string;
  status: AgentRunStatus;
  controlState: AgentRunControlState;
  agentId: string;
};

export function RunControlMenu({
  run,
  align = "right",
  className,
}: {
  run: RunControlMenuRun;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [redirectOpen, setRedirectOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  // Lazy load the agent list only when the redirect sub-menu opens.
  const { data: agents } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: redirectOpen },
  );

  const pauseM = trpc.agentRun.requestPause.useMutation({
    onSuccess: () => {
      toast.success("Pause requested");
      void utils.agentRun.list.invalidate();
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.activeForIssue.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const cancelM = trpc.agentRun.requestCancel.useMutation({
    onSuccess: () => {
      toast.success("Cancel requested");
      void utils.agentRun.list.invalidate();
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.activeForIssue.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const redirectM = trpc.agentRun.requestRedirect.useMutation({
    onSuccess: () => {
      toast.success("Redirected to new agent");
      void utils.agentRun.list.invalidate();
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.activeForIssue.invalidate();
      void utils.issue.byId.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const isActive = run.status === "ACTIVE";
  const pausePending = run.controlState === "PAUSE_REQUESTED";
  const cancelPending = run.controlState === "CANCEL_REQUESTED";
  const anyMutationPending =
    pauseM.isPending || cancelM.isPending || redirectM.isPending;

  const close = () => {
    setOpen(false);
    setRedirectOpen(false);
  };

  return (
    <div ref={containerRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        aria-label="Run controls"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!isActive}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn(
          "focus-ring inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-subtle hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent",
          open && "bg-subtle text-foreground",
        )}
        title={
          isActive
            ? "Run controls — Pause / Cancel / Redirect"
            : `Run is ${run.status.toLowerCase()}`
        }
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>

      <AnchoredPopover
        anchorRef={containerRef}
        open={open}
        onClose={close}
        align={align}
        role="menu"
        className="w-44 rounded-md border border-border bg-card py-1 shadow-md"
      >
          <button
            type="button"
            role="menuitem"
            disabled={pausePending || anyMutationPending}
            title="Pause this run — runtime will stop at next safe point"
            onClick={() => {
              close();
              pauseM.mutate({ runId: run.id });
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <PauseCircle className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{pausePending ? "Pause pending…" : "Pause"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={cancelPending || anyMutationPending}
            title="Cancel this run — runtime will abort"
            onClick={() => {
              close();
              cancelM.mutate({ runId: run.id });
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <StopCircle className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{cancelPending ? "Cancel pending…" : "Cancel"}</span>
          </button>

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            role="menuitem"
            disabled={anyMutationPending}
            title="Hand off to another agent — current run cancels"
            onClick={() => setRedirectOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="flex items-center gap-2">
              <Shuffle className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Redirect to…</span>
            </span>
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground transition-transform",
                redirectOpen && "rotate-90",
              )}
            />
          </button>

          {redirectOpen && (
            <div className="max-h-56 overflow-y-auto border-t border-border py-1">
              {(agents ?? [])
                .filter((a) => a.id !== run.agentId && a.role === "WORKER")
                .map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="menuitem"
                    disabled={anyMutationPending}
                    onClick={() => {
                      close();
                      redirectM.mutate({
                        runId: run.id,
                        toAgentId: a.id,
                      });
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[0.75rem] hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <span aria-hidden className="font-mono text-muted-foreground">
                      @
                    </span>
                    <span className="truncate">{a.profileKey}</span>
                  </button>
                ))}
              {agents !== undefined && agents.length <= 1 && (
                <div className="px-2.5 py-1 text-meta text-muted-foreground">
                  No other agents to redirect to.
                </div>
              )}
              {agents === undefined && (
                <div className="px-2.5 py-1 text-meta text-muted-foreground">
                  Loading agents…
                </div>
              )}
            </div>
          )}
      </AnchoredPopover>
    </div>
  );
}
