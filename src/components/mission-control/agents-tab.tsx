"use client";
import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Agents tab. Roster of workspace agents with status pill, capabilities,
 * current load (active runs), and a click-through to /agents/{profileKey}.
 */

export function AgentsTab({ slug }: { slug: string }) {
  const { data: agents, isLoading } = trpc.agent.list.useQuery({
    includeArchived: false,
  });
  const { data: activeRuns } = trpc.agentRun.activeAll.useQuery({ limit: 50 });

  if (isLoading) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">Loading agents…</div>
    );
  }

  // Count ACTIVE runs per agent for the load chip.
  const loadByAgent = new Map<string, number>();
  for (const run of activeRuns ?? []) {
    loadByAgent.set(run.agentId, (loadByAgent.get(run.agentId) ?? 0) + 1);
  }

  const sorted = [...(agents ?? [])].sort((a, b) => {
    // ONLINE > BUSY > OFFLINE; tiebreak by name.
    const order = { ONLINE: 0, BUSY: 1, OFFLINE: 2 } as const;
    const ao = order[a.status as keyof typeof order] ?? 3;
    const bo = order[b.status as keyof typeof order] ?? 3;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-1.5 overflow-y-auto px-2 py-2">
      {sorted.length === 0 && (
        <div className="px-1 py-2 text-meta text-muted-foreground">
          No agents in this workspace.
        </div>
      )}
      {sorted.map((a) => {
        const load = loadByAgent.get(a.id) ?? 0;
        const cap = a.maxConcurrent;
        const atCap = cap > 0 && load >= cap;
        return (
          <Link
            key={a.id}
            href={`/w/${slug}/agents/${a.profileKey}`}
            className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem] hover:border-ember/40"
          >
            <PresenceDot status={a.status} />
            <Bot className="h-3.5 w-3.5 shrink-0 text-ember" />
            <span className="font-medium text-foreground">{a.name}</span>
            <span className="font-mono text-[0.65625rem] text-muted-foreground">
              @{a.profileKey}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {a.role !== "WORKER" && (
                <span className="rounded-md border border-border bg-subtle px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                  {a.role}
                </span>
              )}
              <span
                className={cn(
                  "font-mono text-[0.65625rem]",
                  atCap ? "text-amber-600" : "text-muted-foreground",
                )}
                title={
                  cap > 0
                    ? `${load} active / ${cap} max`
                    : `${load} active (no cap)`
                }
              >
                {cap > 0 ? `${load}/${cap}` : `${load}`}
              </span>
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function PresenceDot({ status }: { status: string }) {
  const colorClass =
    status === "ONLINE"
      ? "bg-emerald-500"
      : status === "BUSY"
        ? "bg-ember"
        : "bg-muted-foreground/40";
  return (
    <span
      className={cn("h-2 w-2 shrink-0 rounded-full", colorClass)}
      title={status}
    />
  );
}
