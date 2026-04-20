"use client";
import Link from "next/link";
import { useMemo } from "react";
import { InitiativeStatus } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Single-initiative card used on the list page. Shows name, color dot,
 * target date, linked project count, and rolled-up issue completion.
 *
 * Completion rollup queries `issue.list` filtered to this initiative —
 * keeps the router simple and lets the tRPC cache serve repeat renders.
 */
export function InitiativeCard({
  initiative,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  isDragTarget,
}: {
  initiative: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    targetDate: Date | string | null;
    color: string | null;
    status: InitiativeStatus;
    _count: { projects: number };
  };
  draggable?: boolean;
  onDragStart?: (id: string) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (id: string) => void;
  isDragTarget?: boolean;
}) {
  const ws = useWorkspace();
  const { data: issues } = trpc.issue.list.useQuery(
    { initiativeId: initiative.id, includeDone: true, limit: 100 },
    { enabled: initiative._count.projects > 0 },
  );

  const stats = useMemo(() => {
    const items = issues?.items ?? [];
    const done = items.filter(
      (i) =>
        i.status.category === "DONE" || i.status.category === "CANCELED",
    ).length;
    return { done, total: items.length };
  }, [issues]);

  const completion =
    stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100);

  return (
    <Link
      href={`/w/${ws.slug}/initiatives/${initiative.slug}`}
      draggable={draggable}
      onDragStart={(e) => {
        if (draggable) e.dataTransfer.effectAllowed = "move";
        onDragStart?.(initiative.id);
      }}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop?.(initiative.id);
      }}
      className={cn(
        "block rounded-lg border bg-card/40 p-4 hover:border-ember/40",
        MOTION.base,
        isDragTarget ? "border-ember/60 bg-ember/5" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 shrink-0 rounded-sm"
          style={{ backgroundColor: initiative.color ?? "#78716c" }}
        />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">
          {initiative.name}
        </div>
        {initiative.status !== InitiativeStatus.PLANNED && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {initiative.status}
          </span>
        )}
      </div>
      {initiative.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {initiative.description}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {initiative._count.projects} project
          {initiative._count.projects === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>
          {stats.total > 0
            ? `${stats.done}/${stats.total} · ${completion}%`
            : "no issues yet"}
        </span>
        {initiative.targetDate && (
          <>
            <span>·</span>
            <span>
              {new Date(initiative.targetDate).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          </>
        )}
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-subtle">
        <div
          className="h-full rounded-full bg-ember"
          style={{
            width: `${completion}%`,
            backgroundColor: initiative.color ?? undefined,
          }}
        />
      </div>
    </Link>
  );
}
