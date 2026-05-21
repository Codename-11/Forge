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
