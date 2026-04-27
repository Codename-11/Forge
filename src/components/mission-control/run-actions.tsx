"use client";
import { useState } from "react";
import { RotateCw, Bell, X as XIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

interface RunActionsProps {
  runId: string;
  agentName: string;
  /** Compact = icon-only buttons; full = icon+label. Pill rows are tight. */
  size?: "compact" | "full";
}

export function RunActions({ runId, agentName, size = "compact" }: RunActionsProps) {
  const utils = trpc.useUtils();
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [nudgeText, setNudgeText] = useState("checking in");

  const invalidate = () => {
    void utils.agentRun.activeAll.invalidate();
    void utils.agentRun.recentTerminal.invalidate();
    void utils.issue.queue.invalidate();
  };

  const redispatchM = trpc.agentRun.redispatch.useMutation({ onSuccess: invalidate });
  const abandonM = trpc.agentRun.abandon.useMutation({ onSuccess: invalidate });
  const nudgeM = trpc.agentRun.nudge.useMutation({
    onSuccess: () => {
      invalidate();
      setNudging(false);
    },
  });

  const busy = redispatchM.isPending || abandonM.isPending || nudgeM.isPending;
  const iconCls = "h-3 w-3";
  const btnCls = (cn1?: string) =>
    cn(
      "flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-subtle hover:text-foreground transition-colors disabled:opacity-50",
      cn1,
    );

  if (nudging) {
    return (
      <div className="flex items-center gap-1" data-no-drag onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={nudgeText}
          onChange={(e) => setNudgeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              nudgeM.mutate({ runId, message: nudgeText });
            } else if (e.key === "Escape") {
              setNudging(false);
            }
          }}
          placeholder={`Nudge ${agentName}`}
          className="h-5 w-32 rounded border border-border bg-background px-1.5 text-[0.625rem] text-foreground focus:border-ember/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => nudgeM.mutate({ runId, message: nudgeText })}
          disabled={busy || !nudgeText.trim()}
          className={btnCls("text-ember hover:text-ember")}
          title="Send"
        >
          send
        </button>
        <button
          type="button"
          onClick={() => setNudging(false)}
          className={btnCls()}
          title="Cancel"
        >
          <XIcon className={iconCls} />
        </button>
      </div>
    );
  }

  if (confirmAbandon) {
    return (
      <div
        className="flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5"
        data-no-drag
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[0.625rem] text-foreground">Abandon?</span>
        <button
          type="button"
          onClick={() => {
            abandonM.mutate({ runId });
            setConfirmAbandon(false);
          }}
          disabled={busy}
          className={btnCls("text-warning hover:text-warning")}
        >
          yes
        </button>
        <button
          type="button"
          onClick={() => setConfirmAbandon(false)}
          className={btnCls()}
        >
          no
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100"
      data-no-drag
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setNudging(true)}
        disabled={busy}
        className={btnCls()}
        title={`Nudge ${agentName} (post @mention comment)`}
      >
        <Bell className={iconCls} />
        {size === "full" && <span>nudge</span>}
      </button>
      <button
        type="button"
        onClick={() => redispatchM.mutate({ runId })}
        disabled={busy}
        className={btnCls()}
        title="Re-dispatch (clear agent + auto-pick next)"
      >
        <RotateCw className={cn(iconCls, redispatchM.isPending && "animate-spin")} />
        {size === "full" && <span>retry</span>}
      </button>
      <button
        type="button"
        onClick={() => setConfirmAbandon(true)}
        disabled={busy}
        className={btnCls("text-muted-foreground hover:text-warning")}
        title="Abandon run"
      >
        <XIcon className={iconCls} />
        {size === "full" && <span>stop</span>}
      </button>
    </div>
  );
}
