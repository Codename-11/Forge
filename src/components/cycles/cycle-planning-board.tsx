"use client";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui";
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

  const byStatus = useMemo(() => {
    const map = new Map<string, NonNullable<typeof issues>["items"]>();
    for (const s of statuses ?? []) map.set(s.id, []);
    for (const i of issues?.items ?? []) {
      const arr = map.get(i.statusId) ?? [];
      arr.push(i);
      map.set(i.statusId, arr);
    }
    return map;
  }, [statuses, issues]);

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
    return <div className="p-6 text-center text-[11px] text-muted-foreground">Loading board…</div>;
  }

  const hasLoadedIssues = !!issues;
  const hasNoSprintIssues = hasLoadedIssues && (issues?.items.length ?? 0) === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
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
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
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
                        <span className="font-mono text-[10px] text-muted-foreground">
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
                      </div>
                    </Link>
                  </div>
                ))}
                {column.length === 0 && (
                  <div className="py-6 text-center text-[10px] text-muted-foreground/70">
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
