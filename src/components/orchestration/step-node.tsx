"use client";
import { forwardRef } from "react";
import { ExternalLink, RotateCcw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import type { AgentStatus } from "@prisma/client";
import { JudgeVerdictBadge } from "./judge-verdict-badge";
import {
  STEP_STATUS_STYLE,
  isStepActive,
  type DagAgent,
  type DagStep,
} from "./types";

export const STEP_NODE_WIDTH = 184;
export const STEP_NODE_HEIGHT = 72;

function fmtCost(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/**
 * A single step in the DAG — a dense node card.
 *
 * Layout: status dot + status label on top, truncated title, then a
 * meta row with the assigned agent glyph, retry badge (>0 only), and
 * judge verdict chip. RUNNING nodes get a pulsing ember ring; the whole
 * node briefly highlights when its status flips (driven by the parent
 * keying off `status`, which remounts the highlight layer).
 *
 * Click → onSelect (parent links to the plan detail page). Hover lifts
 * the border toward ember. Everything is gated behind motion-safe so
 * reduced-motion users get a static board.
 */
export const StepNode = forwardRef<
  HTMLButtonElement,
  {
    step: DagStep;
    agent?: DagAgent | null;
    /** flag the live execution path */
    active?: boolean;
    onSelect?: () => void;
    /** href to deep-link into the plan detail page */
    href?: string;
  }
>(function StepNode({ step, agent, active, onSelect, href }, ref) {
  const style = STEP_STATUS_STYLE[step.status] ?? STEP_STATUS_STYLE.TODO;
  const running = isStepActive(step.status);
  const retry = step.retryCount ?? 0;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      title={step.title}
      style={{ width: STEP_NODE_WIDTH, height: STEP_NODE_HEIGHT }}
      data-step-status={step.status}
      className={cn(
        "group relative flex flex-col gap-1 rounded-md border bg-card/70 px-2 py-1.5 text-left",
        "transition-colors duration-150 ease-out hover:border-ember/50 hover:bg-card",
        style.ring,
        // M7 (design spec): the single RUNNING node gets the ember
        // active-path glow — inset ring + breathing outer halo. Pairs with
        // the marching `.dag-edge-flow` on the live edges. Reduced-motion /
        // motion-off renders the static inset ring (no pulse).
        running && "forge-active-node",
        active && "ring-1 ring-ember/30",
        // Blocked on a human approve/reject — amber overrides the active glow.
        step.awaitingApproval && "border-amber-500/60 ring-1 ring-amber-500/40",
      )}
    >
      {/* status flip highlight — keyed remount on status change in parent
          gives a brief fade-in flash on the node */}
      <span
        key={step.status}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-md bg-ember/10 motion-safe:animate-out motion-safe:fade-out motion-safe:duration-700"
      />

      <div className="relative z-10 flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            style.dot,
            running && "motion-safe:animate-pulse",
          )}
        />
        <span className="text-[0.5625rem] font-medium uppercase tracking-wider text-muted-foreground">
          {style.label}
        </span>
        {running && (
          <Loader2 className="h-2.5 w-2.5 shrink-0 text-ember motion-safe:animate-spin" />
        )}
        <span className="ml-auto flex items-center gap-1">
          {step.awaitingApproval && (
            <span
              className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/10 px-1 font-mono text-[0.5625rem] text-amber-600 dark:text-amber-400"
              title="Blocked — needs approval to run a command"
            >
              ✋ approval
            </span>
          )}
          {retry > 0 && (
            <span
              className="inline-flex items-center gap-0.5 rounded border border-warning/40 bg-warning/10 px-1 font-mono text-[0.5625rem] text-warning"
              title={`Retried ${retry}×`}
            >
              <RotateCcw className="h-2 w-2" />
              {retry}
            </span>
          )}
          <ExternalLink className="h-2.5 w-2.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
        </span>
      </div>

      <span
        className={cn(
          "relative z-10 line-clamp-2 text-[0.75rem] leading-snug",
          style.text,
        )}
      >
        {step.title}
      </span>

      <div className="relative z-10 mt-auto flex items-center gap-1.5">
        {agent ? (
          <span
            className="inline-flex items-center gap-1 truncate font-mono text-[0.5625rem] text-muted-foreground"
            title={agent.name}
          >
            <AgentPresenceDot
              status={(agent.status as AgentStatus) ?? "OFFLINE"}
              availability={agent.availability}
              size="sm"
            />
            <span className="truncate">@{agent.profileKey}</span>
          </span>
        ) : (
          <span className="font-mono text-[0.5625rem] text-muted-foreground/50">
            unassigned
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {step.costUsd != null && step.costUsd > 0 && (
            <span
              className="font-mono text-[0.5625rem] text-muted-foreground"
              title="Run cost so far"
            >
              {fmtCost(step.costUsd)}
            </span>
          )}
          {step.judgeVerdict && <JudgeVerdictBadge verdict={step.judgeVerdict} />}
        </span>
      </div>
      {href && (
        <a
          href={href}
          onClick={(e) => e.stopPropagation()}
          aria-label="Open in plan detail"
          className="absolute inset-0 z-0"
          tabIndex={-1}
        />
      )}
    </button>
  );
});
