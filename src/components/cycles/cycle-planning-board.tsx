"use client";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui";
import { AgentPresenceDot } from "@/components/agent-presence-dot";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { useWorkspace } from "@/hooks/use-workspace";

type DragPayload =
  | { kind: "board"; issueId: string; fromStatusId: string }
  | { kind: "backlog"; issueId: string };

/**
 * Sprint planning kanban. Internally backed by `cycleId` while product
 * language stays Sprint. Columns are workspace statuses; cards are issues
 * pinned to this sprint. Drag between columns to change status; drag from
 * the backlog side panel into any column to plan the issue into the sprint.
 */
export function CyclePlanningBoard({
  cycleId,
  onPlanCurrentSprint,
  onDropFromBacklog,
}: {
  cycleId: string;
  onPlanCurrentSprint?: () => void;
  onDropFromBacklog: (issueId: string) => void;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: issues } = trpc.issue.list.useQuery({
    cycleId,
    includeDone: true,
    limit: 100,
  });

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Client-side "All projects" filter. Derived from the projects present
  // on the sprint's own issues (no extra query) — `null` = show all.
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const update = trpc.issue.update.useMutation({
    onMutate: async ({ id, statusId }) => {
      if (!statusId) return;
      await utils.issue.list.cancel({ cycleId, includeDone: true, limit: 100 });
      const prev = utils.issue.list.getData({
        cycleId,
        includeDone: true,
        limit: 100,
      });
      utils.issue.list.setData({ cycleId, includeDone: true, limit: 100 }, (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((i) =>
            i.id === id && statusId
              ? {
                  ...i,
                  statusId,
                  status: statuses?.find((s) => s.id === statusId) ?? i.status,
                }
              : i,
          ),
        };
      });
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) utils.issue.list.setData({ cycleId, includeDone: true, limit: 100 }, ctx.prev);
      toast.error(err.message);
    },
    onSettled: () => utils.issue.list.invalidate(),
  });

  // Distinct projects on this sprint's issues, for the filter menu.
  const projectOptions = useMemo(() => {
    const seen = new Map<string, { id: string; key: string; color: string | null }>();
    for (const i of issues?.items ?? []) {
      if (i.project && !seen.has(i.project.id)) {
        seen.set(i.project.id, {
          id: i.project.id,
          key: i.project.key,
          color: i.project.color ?? null,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [issues]);

  const byStatus = useMemo(() => {
    const map = new Map<string, NonNullable<typeof issues>["items"]>();
    for (const s of statuses ?? []) map.set(s.id, []);
    for (const i of issues?.items ?? []) {
      if (projectFilter && i.project?.id !== projectFilter) continue;
      const arr = map.get(i.statusId) ?? [];
      arr.push(i);
      map.set(i.statusId, arr);
    }
    return map;
  }, [statuses, issues, projectFilter]);

  function handleDrop(statusId: string, payload: DragPayload) {
    if (payload.kind === "backlog") {
      onDropFromBacklog(payload.issueId);
      // Also set status to the column we dropped into.
      update.mutate({ id: payload.issueId, statusId });
      return;
    }
    if (payload.fromStatusId === statusId) return;
    update.mutate({ id: payload.issueId, statusId });
  }

  if (!statuses) {
    return <div className="p-6 text-center text-meta text-muted-foreground">Loading board…</div>;
  }

  const hasLoadedIssues = !!issues;
  const hasNoSprintIssues = hasLoadedIssues && (issues?.items.length ?? 0) === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Board header: reorder/retransition hint + an "All projects"
          filter. The filter is client-side over the sprint's own issues,
          so it never touches the drag-drop transitions below. */}
      <div className="flex shrink-0 items-center gap-3 px-3 pt-3 pb-1">
        <span className="text-meta text-muted-foreground/70">
          Drag cards across columns to transition status
        </span>
        {projectOptions.length > 0 && (
          <label className="ml-auto flex items-center gap-1.5 text-meta text-muted-foreground">
            <span className="sr-only">Filter by project</span>
            <select
              value={projectFilter ?? ""}
              onChange={(e) => setProjectFilter(e.target.value || null)}
              className="focus-ring rounded-md border border-border bg-transparent px-2 py-0.5 text-xs text-foreground"
            >
              <option value="">All projects</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.key}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {hasNoSprintIssues && (
        <div className="shrink-0 px-3 pt-3">
          <div className="rounded-lg border border-dashed border-border bg-card/30">
            <EmptyState
              variant="card"
              icon={<Inbox />}
              title="No issues planned for this sprint."
              description="Backlog issues stay separate until you drag them into a sprint column."
              action={
                onPlanCurrentSprint ? (
                  <Button size="sm" variant="outline" onClick={onPlanCurrentSprint}>
                    Plan current sprint
                  </Button>
                ) : undefined
              }
            />
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {statuses.map((s) => {
          const column = byStatus.get(s.id) ?? [];
          const isTarget = dropTarget === s.id;
          return (
            <section
              key={s.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDropTarget(s.id);
              }}
              onDragLeave={() => setDropTarget((t) => (t === s.id ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                const raw = e.dataTransfer.getData("application/x-forge-drag");
                if (!raw) return;
                try {
                  const payload = JSON.parse(raw) as DragPayload;
                  handleDrop(s.id, payload);
                } catch {
                  /* ignore */
                }
              }}
              className={cn(
                "flex w-72 shrink-0 flex-col rounded-lg border bg-card/40",
                MOTION.base,
                isTarget ? "border-ember/60 bg-ember/5" : "border-border",
              )}
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
                  <div
                    key={i.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(
                        "application/x-forge-drag",
                        JSON.stringify({
                          kind: "board",
                          issueId: i.id,
                          fromStatusId: i.statusId,
                        } satisfies DragPayload),
                      );
                    }}
                    className="group cursor-grab rounded-md border border-border bg-background p-2 hover:border-ember/40 active:cursor-grabbing"
                  >
                    <Link href={`/w/${ws.slug}/issues/${i.id}`} className="block">
                      <div className="flex items-center gap-2">
                        <span className="text-id text-muted-foreground">
                          {formatIssueId(ws.key, i.number)}
                        </span>
                        {i.project && (
                          <Badge className="ml-auto" color={i.project.color ?? undefined}>
                            {i.project.key}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 text-sm leading-snug">{i.title}</div>
                      <div className="mt-2 flex items-center gap-1">
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
                  </div>
                ))}
                {column.length === 0 && (
                  <div className="py-6 text-center text-meta text-muted-foreground/70">
                    Drop issues here
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
