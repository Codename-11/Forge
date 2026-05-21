"use client";
import { Activity as ActivityIcon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Activity tab body — the audit-backed event stream for a single issue.
 * Queries `issue.activity` (workspace-scoped, not admin-gated) and renders
 * each event as a compact row. Falls back to a friendly empty state when
 * the subject has no audit rows yet (new issues, tiny workspaces).
 *
 * The underlying ActivityEvent rows are best-effort — not every mutation
 * writes one, so "no activity" is common and doesn't mean an error.
 */

function readDispatch(
  payload: unknown,
): { mode?: string; reason?: string; chosen?: { profileKey?: string; name?: string } } | null {
  if (!payload || typeof payload !== "object") return null;
  const d = (payload as Record<string, unknown>).dispatch;
  if (!d || typeof d !== "object") return null;
  return d as { mode?: string; reason?: string; chosen?: { profileKey?: string; name?: string } };
}

const KIND_LABEL: Record<string, string> = {
  ISSUE_CREATED: "Created issue",
  ISSUE_UPDATED: "Updated",
  ISSUE_DELETED: "Deleted",
  ISSUE_STATUS_CHANGED: "Status changed",
  ISSUE_ASSIGNED: "Assignees changed",
  ISSUE_PRIORITY_CHANGED: "Priority changed",
  ISSUE_STALLED: "Stalled — agent hadn't moved it",
  ISSUE_SLA_BREACH: "SLA breach — past target",
  AGENT_NOACK: "Missed wake — agent didn't ack",
  COMMENT_CREATED: "Commented",
  COMMENT_UPDATED: "Edited comment",
  SKILL_INVOKED: "Skill ran",
  PLUGIN_ERROR: "Plugin error",
};

export function IssueActivityPanel({ issueId }: { issueId: string }) {
  const { data, isLoading } = trpc.issue.activity.useQuery(
    { issueId, limit: 50 },
    // Activity changes in bursts as the issue is edited; no need to refetch
    // aggressively — realtime will invalidate on events anyway.
    { staleTime: 30_000 },
  );

  if (isLoading) {
    return (
      <section className="mt-8 rounded-lg border border-border bg-card/40">
        <header className="flex h-9 items-center gap-2 border-b border-border px-3">
          <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            Activity
          </h2>
        </header>
        <p className="py-6 text-center text-xs text-muted-foreground">
          Loading activity…
        </p>
      </section>
    );
  }

  const rows = data ?? [];

  return (
    <section className="mt-8 rounded-lg border border-border bg-card/40">
      <header className="flex h-9 items-center gap-2 border-b border-border px-3">
        <ActivityIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Activity
        </h2>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          {rows.length}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          No activity yet. Status changes, assignments, and comments will
          show up here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((e) => {
            const dispatch =
              e.kind === "AGENT_ASSIGNED" ? readDispatch(e.payload) : null;
            // When the action came through an agent-linked API key, the
            // Agent is the recorded actor; the human key-owner (`e.actor`)
            // is kept as secondary metadata, surfaced in a tooltip.
            const agent = e.actorAgent;
            return (
              <li key={e.id} className="flex items-start gap-2 px-3 py-2">
                {agent ? (
                  <AgentAvatar
                    agent={{
                      name: agent.name,
                      profileKey: agent.profileKey,
                      avatar: agent.avatar,
                    }}
                    size="xs"
                  />
                ) : (
                  <Avatar
                    name={e.actor?.name ?? null}
                    image={e.actor?.image ?? null}
                    size={18}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5 text-[0.6875rem]">
                    {agent ? (
                      <span
                        className="truncate font-medium"
                        title={
                          e.actor?.name
                            ? `via API key owned by ${e.actor.name}`
                            : undefined
                        }
                      >
                        {agent.name}
                      </span>
                    ) : (
                      <span className="truncate font-medium">
                        {e.actor?.name ?? "System"}
                      </span>
                    )}
                    {agent && (
                      // Indigo `agent` chip mirrors the comment-card badge in
                      // issue-main so "an agent did this" reads consistently.
                      <Badge
                        color="#6366f1"
                        className="font-mono text-[0.6875rem] uppercase tracking-wider"
                      >
                        agent
                      </Badge>
                    )}
                    <span className="truncate text-muted-foreground">
                      {KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, " ").toLowerCase()}
                    </span>
                    {dispatch?.mode && (
                      <span
                        className="ml-1 inline-flex items-center gap-1 rounded-sm bg-subtle px-1 text-[0.6875rem] font-mono uppercase tracking-wider text-muted-foreground"
                        title={dispatch.reason ?? undefined}
                      >
                        {dispatch.mode}
                      </span>
                    )}
                    {dispatch?.chosen?.profileKey && (
                      <span className="ml-1 text-[0.6875rem] font-mono text-muted-foreground">
                        → @{dispatch.chosen.profileKey}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-meta text-muted-foreground">
                    {relativeTime(e.createdAt)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
