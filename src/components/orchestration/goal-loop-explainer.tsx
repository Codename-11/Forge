"use client";
import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  GitBranch,
  Info,
  ListChecks,
  Play,
  ShieldCheck,
  Target,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Explains what a Goal actually *is*: an automated orchestrator-judge
 * loop that runs to completion, not a static checklist. Shown on the
 * goals index, in the create modal, and (collapsed) on goal detail so a
 * first-time operator understands the implications before kicking one
 * off. Single source of truth for the loop's phase copy.
 */
export const GOAL_LOOP_PHASES: Array<{
  icon: typeof Target;
  title: string;
  body: string;
}> = [
  {
    icon: Target,
    title: "Objective",
    body: "You state a high-level goal and (optionally) assign a crew to run it.",
  },
  {
    icon: GitBranch,
    title: "Plan",
    body: "The crew's planner decomposes the goal into a dependency-ordered set of steps.",
  },
  {
    icon: ListChecks,
    title: "Approve",
    body: "You review the proposed plan and approve it. Nothing runs until you do.",
  },
  {
    icon: Play,
    title: "Execute",
    body: "Workers pick up steps as their dependencies clear and run them in parallel.",
  },
  {
    icon: ShieldCheck,
    title: "Review",
    body: "A reviewer judges each finished step. A pass advances the plan; a fail sends it back with feedback to retry.",
  },
  {
    icon: CheckCircle2,
    title: "Achieved",
    body: "When every step passes, the goal completes. Budget and time caps stop runaway loops automatically.",
  },
];

/**
 * Full callout — a numbered phase list. Use on empty states and detail
 * pages where there's room to teach.
 */
export function GoalLoopExplainer({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/40 p-4 text-left",
        className,
      )}
    >
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Info className="h-4 w-4 text-ember" />
        How goals run
      </div>
      <p className="mb-3 text-meta text-muted-foreground">
        A goal is an <span className="text-foreground">automated loop</span>,
        not a checklist. A crew plans it, you approve, then agents execute and
        review steps — retrying failures — until the objective is met or a
        budget cap stops it.
      </p>
      <ol className="flex flex-col gap-2">
        {GOAL_LOOP_PHASES.map((phase, i) => {
          const Icon = phase.icon;
          return (
            <li key={phase.title} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-subtle text-[10px] font-medium tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {phase.title}
                </span>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  {phase.body}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Collapsible variant for detail pages — a one-line "How this runs"
 * affordance that expands to the full explainer. Defaults collapsed.
 */
export function GoalLoopExplainerCollapsible({
  className,
}: {
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2 text-meta text-muted-foreground transition hover:bg-subtle"
      >
        <Info className="h-3.5 w-3.5 text-ember" />
        <span className="flex-1 text-left">How this goal runs</span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? <GoalLoopExplainer className="mt-2" /> : null}
    </div>
  );
}
