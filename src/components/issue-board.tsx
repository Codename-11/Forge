"use client";
import { useMemo } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Status-column kanban board. Drag-and-drop is intentionally left as a
 * future enhancement — the keyboard-first path (bulk-select + status set)
 * already covers the primary workflow.
 */
export function IssueBoard({
  workspaceKey,
  projectId,
  assigneeId,
  cycleId,
  initiativeId,
}: {
  workspaceKey: string;
  projectId?: string;
  assigneeId?: string;
  /** Tri-state: `undefined` = any; `null` = backlog; string = specific id. */
  cycleId?: string | null;
  /** Tri-state: `undefined` = any; `null` = no initiative; string = id. */
  initiativeId?: string | null;
}) {
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: issues } = trpc.issue.list.useQuery({
    includeDone: true,
    limit: 100,
    projectId,
    assigneeId,
    cycleId,
    initiativeId,
  });
  const ws = useMaybeWorkspace();
  const base = ws ? `/w/${ws.slug}` : "";

  const byStatus = useMemo(() => {
    const map = new Map<string, typeof issues extends { items: infer U } ? U : never>();
    for (const s of statuses ?? []) (map as any).set(s.id, []);
    for (const i of issues?.items ?? []) {
      const arr = (map as any).get(i.statusId) ?? [];
      arr.push(i);
      (map as any).set(i.statusId, arr);
    }
    return map;
  }, [statuses, issues]);

  if (!statuses) return null;

  return (
    <div className="flex h-[calc(100svh-6rem)] gap-3 overflow-x-auto px-4 py-3">
      {statuses.map((s) => {
        const column = ((byStatus as any).get(s.id) ?? []) as NonNullable<typeof issues>["items"];
        return (
          <section
            key={s.id}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-card/40"
          >
            <header className="flex h-9 items-center gap-2 border-b border-border px-3">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="text-xs font-medium">{s.name}</span>
              <span className="ml-auto font-mono text-[0.6875rem] text-muted-foreground">
                {column.length}
              </span>
            </header>
            <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
              {column.map((i) => (
                <Link
                  key={i.id}
                  href={`${base}/issues/${i.id}`}
                  className="block rounded-md border border-border bg-background p-2 text-left hover:border-ember/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-id text-muted-foreground">
                      {workspaceKey}-{i.number}
                    </span>
                    {i.project && (
                      <Badge className="ml-auto" color={i.project.color ?? undefined}>
                        {i.project.key}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 text-sm leading-snug">{i.title}</div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex -space-x-1.5">
                      {i.assignees.slice(0, 3).map((a) => (
                        <Avatar
                          key={a.userId}
                          name={a.user.name}
                          image={a.user.image}
                          size={16}
                          className="ring-1 ring-background"
                        />
                      ))}
                    </div>
                    {i.assignedAgent && (
                      <span
                        className="inline-flex items-center gap-1 text-meta text-muted-foreground"
                        title={`Agent: ${i.assignedAgent.name}`}
                      >
                        <AgentPresenceDot
                          status={i.assignedAgent.status}
                          size="sm"
                        />
                        <span className="text-id">
                          @{i.assignedAgent.profileKey}
                        </span>
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
