"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, ChevronDown, Send, ExternalLink, Shield } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Queue tab. Renders queued + unassigned issues with an inline agent
 * picker per row + a single "Dispatch all unblocked" footer button.
 *
 * Inline assignment uses `issue.update({ assignedAgentId })` — the
 * existing event hook in `recordChange()` fires AGENT_ASSIGNED, the
 * worker pushes the webhook, and AgentRun lifecycle takes over the
 * moment the agent acks. No separate dispatch mutation needed.
 */

type AgentLite = {
  id: string;
  name: string;
  profileKey: string;
  status: string;
  /** Avg cost per run over the last 30d — helps right-size a dispatch. */
  avgCostUsd?: number;
};

function fmtCost(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

export function QueueTab({ slug }: { slug: string }) {
  const utils = trpc.useUtils();
  const { data: queue, isLoading } = trpc.issue.queue.useQuery({
    includeClaimed: false,
    limit: 30,
  });
  const { data: agents } = trpc.agent.list.useQuery({ includeArchived: false });
  const { data: costStats } = trpc.agentRun.costByAgent.useQuery(
    { sinceDays: 30 },
    { staleTime: 60_000 },
  );

  const eligibleAgents: AgentLite[] = useMemo(() => {
    const costById = new Map((costStats?.byAgent ?? []).map((c) => [c.agentId, c]));
    return (agents ?? [])
      .filter((a) => a.role === "WORKER" && !a.archivedAt)
      .map((a) => {
        const c = costById.get(a.id);
        return {
          id: a.id,
          name: a.name,
          profileKey: a.profileKey,
          status: a.status,
          avgCostUsd: c && c.runs > 0 ? c.costUsd / c.runs : undefined,
        };
      });
  }, [agents, costStats]);

  const update = trpc.issue.update.useMutation({
    onSuccess: () => {
      void utils.issue.queue.invalidate();
      void utils.issue.list.invalidate();
      void utils.agentRun.activeAll.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const dispatchOne = (issueId: string, agentId: string, label: string) => {
    update.mutate(
      { id: issueId, assignedAgentId: agentId },
      {
        onSuccess: () => toast.success(`Dispatched to ${label}`),
      },
    );
  };

  const dispatchAllUnblocked = () => {
    const unassigned =
      queue?.filter((q) => !q.assignedAgent && q.unblocked !== false) ?? [];
    if (unassigned.length === 0) {
      toast.info("Nothing to dispatch.");
      return;
    }
    if (eligibleAgents.length === 0) {
      toast.error("No eligible WORKER agents available.");
      return;
    }
    // Round-robin across eligible agents.
    let cursor = 0;
    for (const issue of unassigned) {
      const agent = eligibleAgents[cursor % eligibleAgents.length];
      cursor++;
      update.mutate({ id: issue.id, assignedAgentId: agent.id });
    }
    toast.success(`Dispatched ${unassigned.length} to ${eligibleAgents.length} agent(s).`);
  };

  if (isLoading) {
    return (
      <div className="px-3 py-4 text-meta text-muted-foreground">Loading queue…</div>
    );
  }

  const items = queue ?? [];
  const unassignedCount = items.filter((q) => !q.assignedAgent).length;
  const blockedCount = items.filter((q) => q.unblocked === false).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-1 space-y-1.5 overflow-y-auto px-2 py-2">
        {items.length === 0 && (
          <div className="px-1 py-2 text-meta text-muted-foreground">
            Queue is empty.
          </div>
        )}
        {items.map((issue) => {
          const issueKey = `${(issue as unknown as { workspace?: { key: string } }).workspace?.key ?? slug.toUpperCase()}-${issue.number}`;
          return (
            <QueueRow
              key={issue.id}
              slug={slug}
              issue={{
                id: issue.id,
                number: issue.number,
                title: issue.title,
                key: issueKey,
                blocked: issue.unblocked === false,
                assignedAgent: issue.assignedAgent
                  ? {
                      id: issue.assignedAgent.id,
                      name: issue.assignedAgent.name,
                      profileKey: issue.assignedAgent.profileKey,
                    }
                  : null,
              }}
              agents={eligibleAgents}
              onDispatch={(agentId, label) => dispatchOne(issue.id, agentId, label)}
            />
          );
        })}
      </div>
      <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 text-meta">
        <span className="text-muted-foreground">
          {unassignedCount} unassigned
          {blockedCount > 0 && (
            <>
              {" "}· <span className="text-amber-600">{blockedCount} blocked</span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={dispatchAllUnblocked}
          disabled={unassignedCount === 0 || eligibleAgents.length === 0}
          className={cn(
            "flex items-center gap-1 rounded-md bg-ember px-2 py-1 text-[0.6875rem] font-medium text-ember-foreground hover:bg-ember/90 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Send className="h-3 w-3" /> Dispatch all
        </button>
      </div>
    </div>
  );
}

function QueueRow({
  slug,
  issue,
  agents,
  onDispatch,
}: {
  slug: string;
  issue: {
    id: string;
    number: number;
    title: string;
    key: string;
    blocked: boolean;
    assignedAgent: { id: string; name: string; profileKey: string } | null;
  };
  agents: AgentLite[];
  onDispatch: (agentId: string, agentLabel: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-[0.75rem]">
      <div className="flex items-center gap-2">
        {issue.blocked && (
          <Shield className="h-3 w-3 shrink-0 text-amber-600" aria-label="Blocked" />
        )}
        <Link
          href={`/w/${slug}/issues/${issue.id}`}
          className="shrink-0 font-mono text-[0.6875rem] text-foreground/80 hover:text-ember"
        >
          {issue.key}
        </Link>
        <span className="truncate text-foreground" title={issue.title}>
          {issue.title}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {issue.assignedAgent ? (
            <span
              className="flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 font-mono text-[0.65625rem] text-indigo-700 dark:text-indigo-300"
              title={`Assigned to ${issue.assignedAgent.name}`}
            >
              <Bot className="h-3 w-3" />
              {issue.assignedAgent.profileKey}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className={cn(
                "flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[0.65625rem] text-muted-foreground hover:border-ember/40 hover:text-foreground",
                open && "border-ember/40 text-foreground",
              )}
            >
              Dispatch <ChevronDown className="h-2.5 w-2.5" />
            </button>
          )}
          <Link
            href={`/w/${slug}/issues/${issue.id}`}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-subtle hover:text-foreground"
            aria-label="Open issue"
            title="Open issue"
          >
            <ExternalLink className="h-3 w-3" />
          </Link>
        </span>
      </div>
      {open && !issue.assignedAgent && (
        <div className="mt-1.5 flex flex-wrap gap-1 border-t border-border/60 pt-1.5">
          {agents.length === 0 ? (
            <span className="text-meta text-muted-foreground">
              No eligible WORKER agents.
            </span>
          ) : (
            agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onDispatch(a.id, a.name);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[0.65625rem] hover:border-ember/40",
                  a.status === "OFFLINE" && "opacity-60",
                )}
                title={`Status: ${a.status}`}
              >
                <Bot className="h-3 w-3 text-ember" /> @{a.profileKey}
                {a.avgCostUsd != null && (
                  <span
                    className="ml-1 text-meta text-muted-foreground"
                    title="Avg cost per run, last 30d"
                  >
                    ~{fmtCost(a.avgCostUsd)}
                  </span>
                )}
                {a.status === "OFFLINE" && (
                  <span className="ml-1 text-meta text-muted-foreground">
                    (offline)
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
