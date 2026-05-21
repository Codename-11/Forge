import { cn } from "@/lib/utils";

/**
 * Crew member roles. Mirrors `AGENT_CREW_ROLES` in
 * `agent-crew-service.ts` — kept as a literal here so client components
 * compile without importing the server-only service.
 */
export const CREW_ROLES = [
  "PLANNER",
  "WORKER",
  "REVIEWER",
  "OBSERVER",
  "OPERATOR_PROXY",
] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

/** Display order for role-breakdown summaries (planner → worker → …). */
export const CREW_ROLE_ORDER: CrewRole[] = [
  "PLANNER",
  "WORKER",
  "REVIEWER",
  "OBSERVER",
  "OPERATOR_PROXY",
];

/**
 * Warm-earthy role tones. Token-driven — ember for the planner (the one
 * driving), neutral subtle for workers, amber for reviewers, muted for
 * passive observers, emerald for the operator proxy (human stand-in).
 */
const ROLE_TONE: Record<CrewRole, string> = {
  PLANNER: "bg-ember/15 text-ember",
  WORKER: "bg-subtle text-foreground",
  REVIEWER: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  OBSERVER: "bg-muted/40 text-muted-foreground",
  OPERATOR_PROXY: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

export function roleTone(role: string): string {
  return ROLE_TONE[role as CrewRole] ?? ROLE_TONE.OBSERVER;
}

/**
 * What each role *does* in an orchestration run — the single source of
 * truth for role copy across the crew picker, roster, and docs. Keep the
 * `summary` to one tight sentence (shown in pickers) and `detail` to the
 * "why you'd assign it" (shown on hover / in expanded help).
 */
export const ROLE_META: Record<
  CrewRole,
  { label: string; summary: string; detail: string }
> = {
  PLANNER: {
    label: "Planner",
    summary: "Breaks the goal into an ordered plan of steps.",
    detail:
      "The brain of the crew. When a goal starts, the planner decomposes it into a dependency-ordered execution plan. You approve that plan before any work begins.",
  },
  WORKER: {
    label: "Worker",
    summary: "Executes the plan's steps and reports results.",
    detail:
      "The hands of the crew. Workers pick up steps the moment their dependencies clear and run them in parallel up to the crew's parallel cap.",
  },
  REVIEWER: {
    label: "Reviewer",
    summary: "Judges each finished step — pass to advance, fail to retry.",
    detail:
      "The quality gate. After a worker finishes a step, a reviewer verdicts it. A pass advances the plan; a fail sends the step back with feedback for another attempt.",
  },
  OBSERVER: {
    label: "Observer",
    summary: "Watches the run without acting.",
    detail:
      "Read-only presence — for audit, logging, or keeping a stakeholder agent in the loop. Observers never get assigned steps.",
  },
  OPERATOR_PROXY: {
    label: "Operator proxy",
    summary: "Stands in for you — can approve gates while you're away.",
    detail:
      "A human stand-in. When the loop hits an approval gate or a blocking question and you're not around, the operator proxy can respond so the run keeps moving.",
  },
};

/** One-line role summary for pickers and tooltips. */
export function roleSummary(role: string): string {
  return ROLE_META[role as CrewRole]?.summary ?? "";
}

/** Lowercased, space-separated label (e.g. "operator proxy"). */
export function roleLabel(role: string): string {
  return role.toLowerCase().replace(/_/g, " ");
}

export function RoleChip({
  role,
  className,
}: {
  role: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
        roleTone(role),
        className,
      )}
    >
      {roleLabel(role)}
    </span>
  );
}

/**
 * Build a role-breakdown summary string from member rows, e.g.
 * "1 planner · 3 workers · 1 reviewer". Pluralizes the role label.
 */
export function roleBreakdown(
  members: ReadonlyArray<{ role: string }>,
): string {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
  const parts: string[] = [];
  for (const role of CREW_ROLE_ORDER) {
    const n = counts.get(role);
    if (!n) continue;
    const label = roleLabel(role);
    parts.push(`${n} ${n === 1 ? label : pluralize(label)}`);
  }
  // Any non-standard roles fall through.
  for (const [role, n] of counts) {
    if ((CREW_ROLE_ORDER as string[]).includes(role)) continue;
    const label = roleLabel(role);
    parts.push(`${n} ${n === 1 ? label : pluralize(label)}`);
  }
  return parts.join(" · ");
}

function pluralize(label: string): string {
  // "operator proxy" → "operator proxies"; everything else → +s.
  if (label.endsWith("y")) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}
