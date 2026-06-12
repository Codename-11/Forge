"use client";
import { Check, ShieldAlert, X } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * Operator approval card for a connector-driven run paused awaiting
 * permission (Codex/Hermes flagged a command or file change). Shared by the
 * Mission Control Live tab (`RunRow`) and the issue right-rail
 * (`IssueAgentPanel`) so an approval is actionable wherever the operator is
 * looking — not buried in one surface.
 *
 * Approve grants **session** scope by default (`acceptForSession`) so a
 * research sweep doesn't re-prompt on every command; the per-command "once"
 * path is still available via the secondary link.
 */

/** Narrow the JSON `pendingApproval` blob to its displayable fields. */
export function readPendingApproval(v: unknown): {
  command: string | null;
  description: string | null;
} {
  if (!v || typeof v !== "object") return { command: null, description: null };
  const o = v as Record<string, unknown>;
  return {
    command: typeof o.command === "string" ? o.command : null,
    description: typeof o.description === "string" ? o.description : null,
  };
}

export function RunApprovalCard({
  runId,
  agentName,
  pendingApproval,
  onResolved,
}: {
  runId: string;
  agentName: string;
  pendingApproval: unknown;
  /** Extra invalidation hook for the host surface (e.g. issue.byId). */
  onResolved?: () => void;
}) {
  const utils = trpc.useUtils();
  const approval = readPendingApproval(pendingApproval);
  const respond = trpc.agentRun.respondApproval.useMutation({
    onSettled: () => {
      void utils.agentRun.activeAll.invalidate();
      void utils.agentRun.activeForIssue.invalidate();
      onResolved?.();
    },
  });

  return (
    <div
      className="text-meta flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5"
      data-no-drag
      onClick={(e) => e.stopPropagation()}
    >
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 text-foreground/80">
        {agentName} needs permission
        {approval.command ? (
          <>
            {" "}
            to run{" "}
            <code className="rounded bg-background/60 px-1 font-mono text-[0.625rem] text-foreground">
              {approval.command.length > 80
                ? `${approval.command.slice(0, 77)}…`
                : approval.command}
            </code>
          </>
        ) : (
          " to run a command"
        )}
        {approval.description ? (
          <span className="mt-0.5 block text-[0.625rem] text-muted-foreground">
            {approval.description}
          </span>
        ) : null}
        <button
          type="button"
          disabled={respond.isPending}
          onClick={() => respond.mutate({ runId, decision: "approve", scope: "once" })}
          className="mt-1 block text-[0.625rem] text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          title="Approve only this one command"
        >
          Just this once
        </button>
      </span>
      <button
        type="button"
        disabled={respond.isPending}
        onClick={() => respond.mutate({ runId, decision: "approve", scope: "session" })}
        title="Approve and stop re-prompting for similar commands this run"
        className="inline-flex min-h-8 items-center gap-1 rounded border border-ember/40 bg-ember/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-ember hover:bg-ember/25 disabled:opacity-50 sm:min-h-0"
      >
        <Check className="h-3 w-3" /> Approve
      </button>
      <button
        type="button"
        disabled={respond.isPending}
        onClick={() => respond.mutate({ runId, decision: "reject" })}
        className="inline-flex min-h-8 items-center gap-1 rounded border border-border bg-card/40 px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:text-foreground disabled:opacity-50 sm:min-h-0"
      >
        <X className="h-3 w-3" /> Reject
      </button>
    </div>
  );
}
