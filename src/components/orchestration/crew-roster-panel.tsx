"use client";
import { useMemo } from "react";
import Link from "next/link";
import type { AgentStatus } from "@prisma/client";
import { ArrowUpRight, Users } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { presenceAvailability, type AvailabilityModel } from "@/lib/transport-display";
import { cn } from "@/lib/utils";

/**
 * Read-only crew roster panel for the plan + goal cockpits. Surfaces
 * WHO is executing — the crew name and each member with avatar,
 * @profileKey, a role chip, and a live presence dot. When a member is
 * currently on a step (cross-referenced from the active ExecutionSteps'
 * `assignedAgentId`), their row lights ember and shows the step title.
 *
 * Full roster editing lives on the crew detail page (owned elsewhere) —
 * this is display only. It owns its own compact markup so it never
 * depends on `@/components/crews/*`.
 *
 * Tokens only — no hardcoded colors.
 */

export type CrewMemberRow = {
  id: string;
  role: string;
  position?: number;
  agent: {
    id: string;
    name: string;
    profileKey: string;
    avatar?: string | null;
    status?: AgentStatus | null;
    lastHeartbeatAt?: string | Date | null;
  };
};

export type CrewRosterData = {
  id: string;
  name: string;
  maxParallel?: number | null;
  members: CrewMemberRow[];
};

/** Map of agentId → the step that agent is currently queued or working. */
export type ActiveStepByAgent = Map<
  string,
  { id: string; title: string; status?: string }
>;

const ROLE_TONE: Record<string, string> = {
  PLANNER: "bg-ember/10 text-ember",
  WORKER: "bg-subtle text-muted-foreground",
  REVIEWER: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  OBSERVER: "bg-muted/40 text-muted-foreground",
  OPERATOR_PROXY: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

export function CrewRosterPanel({
  crew,
  activeByAgent,
  className,
}: {
  crew: CrewRosterData | null | undefined;
  /** Which agent is live on which step — drives the highlight. */
  activeByAgent?: ActiveStepByAgent;
  className?: string;
}) {
  const ws = useMaybeWorkspace();
  // The crew prop (from plan/goal queries) doesn't carry the on-demand presence
  // signal; agent.list does. Map agentId → availability so member dots read
  // "on-demand" for a managed app-server agent instead of a false "offline".
  const { data: agentsData } = trpc.agent.list.useQuery(
    { includeArchived: false },
    { enabled: Boolean(ws), staleTime: 30_000 },
  );
  const availabilityById = useMemo(() => {
    const m = new Map<string, AvailabilityModel>();
    for (const a of agentsData ?? []) m.set(a.id, presenceAvailability(a));
    return m;
  }, [agentsData]);
  if (!crew) return null;
  const members = crew.members ?? [];
  const crewHref = ws ? `/w/${ws.slug}/crews/${crew.id}` : null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card/40 p-3",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-meta uppercase tracking-wide text-muted-foreground">
          <Users className="h-3 w-3" />
          <span>Crew</span>
        </div>
        {crewHref ? (
          <Link
            href={crewHref}
            className="group inline-flex items-center gap-0.5 truncate text-meta font-medium text-foreground hover:text-ember"
          >
            <span className="truncate">{crew.name}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        ) : (
          <span className="truncate text-meta font-medium text-foreground">
            {crew.name}
          </span>
        )}
      </div>

      {members.length === 0 ? (
        <p className="text-meta text-muted-foreground/70">
          No members on this crew yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {members.map((m) => {
            const active = activeByAgent?.get(m.agent.id) ?? null;
            return (
              <li
                key={m.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors",
                  active
                    ? "border-ember/40 bg-ember/[0.05]"
                    : "border-transparent",
                )}
                title={
                  active
                    ? `@${m.agent.profileKey} · ${(active.status ?? "active").toLowerCase()} "${active.title}"`
                    : `@${m.agent.profileKey}`
                }
              >
                <span className="relative inline-flex shrink-0 items-center">
                  <Avatar name={m.agent.name} image={m.agent.avatar} size={20} />
                  <AgentPresenceDot
                    status={(m.agent.status ?? "OFFLINE") as AgentStatus}
                    lastHeartbeatAt={m.agent.lastHeartbeatAt}
                    availability={availabilityById.get(m.agent.id)}
                    className="absolute -bottom-0.5 -right-0.5 ring-1 ring-card"
                  />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-id">
                    @{m.agent.profileKey}
                  </span>
                  {active ? (
                    <span className="flex items-center gap-1 truncate text-meta text-ember">
                      <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-ember motion-safe:animate-pulse" />
                      <span className="truncate">
                        {active.status ? `${active.status.toLowerCase()}: ` : ""}
                        {active.title}
                      </span>
                    </span>
                  ) : null}
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    ROLE_TONE[m.role] ?? "bg-subtle text-muted-foreground",
                  )}
                >
                  {m.role.toLowerCase().replace(/_/g, " ")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
