"use client";
import Link from "next/link";
import { InitiativeStatus } from "@prisma/client";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Single-initiative card used on the list page. Shows name, color dot,
 * target date, linked project count, and rolled-up issue completion.
 *
 * Counts come pre-rolled from `initiative.list` (Phase 1D) — no per-
 * card `issue.list` roundtrip. Cards render synchronously with the rest
 * of the grid and don't churn the tRPC cache when the list grows.
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
    /**
     * `issues` and `doneIssues` are projected by `initiative.list`. They
     * fall back to 0 so this component still renders if a caller
     * supplies a partial shape (legacy `initiative.get` etc.).
     */
    _count: { projects: number; issues?: number; doneIssues?: number };
    /**
     * Nested per-project tally, projected by `initiative.list`. Optional so
     * partial-shape callers (legacy `initiative.get` etc.) still render.
     */
    projects?: Array<{
      id: string;
      key: string;
      name: string;
      color: string | null;
      done: number;
      total: number;
    }>;
  };
  draggable?: boolean;
  onDragStart?: (id: string) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (id: string) => void;
  isDragTarget?: boolean;
}) {
  const ws = useWorkspace();
  const total = initiative._count.issues ?? 0;
  const done = initiative._count.doneIssues ?? 0;
  const completion = total === 0 ? 0 : Math.round((done / total) * 100);
  const projects = initiative.projects ?? [];
  const PROJECT_CAP = 4;
  const visibleProjects = projects.slice(0, PROJECT_CAP);
  const hiddenProjectCount = projects.length - visibleProjects.length;

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
          <span className="text-id text-muted-foreground">
            {initiative.status}
          </span>
        )}
      </div>
      {initiative.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {initiative.description}
        </p>
      )}
      <div className="text-meta mt-3 flex items-center gap-3 text-muted-foreground">
        <span>
          {initiative._count.projects} project
          {initiative._count.projects === 1 ? "" : "s"}
        </span>
        <span>·</span>
        <span>
          {total > 0
            ? `${done}/${total} · ${completion}%`
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
      {visibleProjects.length > 0 && (
        <ul className="mt-3 space-y-1">
          {visibleProjects.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 text-meta text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: p.color ?? "#78716c" }}
              />
              <span className="text-id shrink-0">{p.key}</span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {p.name}
              </span>
              <span className="shrink-0 tabular-nums">
                {p.done}/{p.total}
              </span>
            </li>
          ))}
          {hiddenProjectCount > 0 && (
            <li className="text-meta text-muted-foreground">
              +{hiddenProjectCount} more
            </li>
          )}
        </ul>
      )}
    </Link>
  );
}
