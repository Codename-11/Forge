"use client";
import type { ReactNode } from "react";
import { Diamond, Folder, FolderKanban, Repeat, Target } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Spinner } from "@/components/ui/spinner";
import { HoverPreviewPortal } from "@/components/ui/hover-preview-portal";
import { trpc } from "@/lib/trpc";
import { cn, formatDate } from "@/lib/utils";

/**
 * Hover-preview popover for project / initiative / cycle chips.
 *
 * One wrapper component, three card layouts switched by `kind`. The
 * data shape per kind is dispatched to a small sub-card so each row
 * only renders the rows that make sense for that entity.
 *
 * Inputs are minimal — id (project, cycle) or slug-or-id (initiative).
 * The wrapped chip's click semantics are unchanged.
 */
export type EntityHoverKind = "project" | "initiative" | "cycle";

export type EntityHoverPreviewProps = {
  className?: string;
  children: ReactNode;
} & (
  | { kind: "project"; id: string; slug?: undefined }
  | { kind: "initiative"; id?: string; slug?: string }
  | { kind: "cycle"; id: string; slug?: undefined }
);

export function EntityHoverPreview({
  kind,
  id,
  slug,
  className,
  children,
}: EntityHoverPreviewProps) {
  return (
    <HoverPreviewPortal
      className={className}
      render={() => {
        if (kind === "project" && id)
          return <ProjectCard id={id} />;
        if (kind === "initiative")
          return <InitiativeCard id={id} slug={slug} />;
        if (kind === "cycle" && id) return <CycleCard id={id} />;
        return <NotFound label="—" />;
      }}
    >
      {children}
    </HoverPreviewPortal>
  );
}

function NotFound({ label }: { label: string }) {
  return (
    <div className="px-3 py-2.5">
      <div className="font-mono text-meta text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xs text-muted-foreground/80">Not found</div>
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 text-meta text-muted-foreground">
      <Spinner size="sm" />
      <span className="font-mono">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function ProjectCard({ id }: { id: string }) {
  const { data, isLoading, error } = trpc.project.summary.useQuery(
    { id },
    { staleTime: 60_000, retry: false, refetchOnWindowFocus: false },
  );
  if (isLoading) return <LoadingRow label="project" />;
  if (error || !data) return <NotFound label="project" />;

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: icon + key + name */}
      <div className="flex items-center gap-2">
        {data.icon ? (
          <span className="shrink-0 text-[0.875rem]" aria-hidden>
            {data.icon}
          </span>
        ) : data.color ? (
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-sm"
            style={{ backgroundColor: data.color }}
            aria-hidden
          />
        ) : (
          <Folder
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        )}
        <span className="shrink-0 font-mono text-[0.6875rem] text-foreground/90">
          {data.key}
        </span>
        <span aria-hidden className="text-muted-foreground/40">
          ·
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground">
          {data.name}
        </span>
        {data.archived && (
          <span className="shrink-0 rounded border border-border bg-subtle px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
            archived
          </span>
        )}
      </div>

      {/* Row 2: counts */}
      <div className="mt-2 flex items-center gap-3 text-meta text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <FolderKanban className="h-3 w-3 shrink-0" />
          {data.activeIssueCount} active issue
          {data.activeIssueCount === 1 ? "" : "s"}
        </span>
        <span aria-hidden className="text-muted-foreground/40">
          ·
        </span>
        <span>
          {data.memberCount} member{data.memberCount === 1 ? "" : "s"}
        </span>
      </div>

      {/* Row 3: owner */}
      {data.createdBy && (
        <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-meta text-muted-foreground">
          <Avatar
            name={data.createdBy.name}
            image={data.createdBy.image}
            size={18}
          />
          <span className="truncate">
            {data.createdBy.name ?? "Owner"}
          </span>
          {data.targetDate && (
            <span className="ml-auto">
              due {formatDate(data.targetDate, undefined, { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Initiative
// ---------------------------------------------------------------------------

function InitiativeCard({ id, slug }: { id?: string; slug?: string }) {
  const { data, isLoading, error } = trpc.initiative.summary.useQuery(
    id ? { id } : { slug: slug ?? "" },
    {
      enabled: Boolean(id || slug),
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  if (isLoading) return <LoadingRow label="initiative" />;
  if (error || !data) return <NotFound label="initiative" />;

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: diamond + name + status */}
      <div className="flex items-center gap-2">
        <Diamond
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: data.color ?? undefined }}
          fill={data.color ?? "currentColor"}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground">
          {data.name}
        </span>
        <InitiativeStatusPill status={data.status} />
      </div>

      {/* Row 2: counts */}
      <div className="mt-2 flex items-center gap-3 text-meta text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Folder className="h-3 w-3 shrink-0" />
          {data.projectCount} project{data.projectCount === 1 ? "" : "s"}
        </span>
        <span aria-hidden className="text-muted-foreground/40">
          ·
        </span>
        <span className="inline-flex items-center gap-1">
          <FolderKanban className="h-3 w-3 shrink-0" />
          {data.activeIssueCount} active
        </span>
      </div>

      {/* Row 3: owner + target date */}
      {(data.createdBy || data.targetDate) && (
        <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-meta text-muted-foreground">
          {data.createdBy && (
            <>
              <Avatar
                name={data.createdBy.name}
                image={data.createdBy.image}
                size={18}
              />
              <span className="truncate">{data.createdBy.name ?? "Owner"}</span>
            </>
          )}
          {data.targetDate && (
            <span className="ml-auto inline-flex items-center gap-1">
              <Target className="h-3 w-3 shrink-0" />
              {formatDate(data.targetDate, undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function InitiativeStatusPill({ status }: { status: string }) {
  // Map known status tokens to warm-earthy tones; unknown values fall
  // through to the muted neutral.
  const tone = (() => {
    if (status === "ACTIVE" || status === "IN_PROGRESS")
      return "border-success/40 bg-success/10 text-success";
    if (status === "PAUSED")
      return "border-warning/40 bg-warning/10 text-warning";
    if (status === "COMPLETED")
      return "border-ember/40 bg-ember/10 text-ember";
    if (status === "CANCELED")
      return "border-border bg-subtle/60 text-muted-foreground line-through";
    return "border-border bg-subtle/60 text-muted-foreground";
  })();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider",
        tone,
      )}
    >
      {status.toLowerCase().replace(/_/g, " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cycle (Sprint in UI)
// ---------------------------------------------------------------------------

function CycleCard({ id }: { id: string }) {
  const { data, isLoading, error } = trpc.cycle.summary.useQuery(
    { id },
    { staleTime: 60_000, retry: false, refetchOnWindowFocus: false },
  );
  if (isLoading) return <LoadingRow label="sprint" />;
  if (error || !data) return <NotFound label="sprint" />;

  const total = data.total || 1;
  const donePct = Math.round((data.counts.done / total) * 100);
  const inFlightPct = Math.round((data.counts.inFlight / total) * 100);

  return (
    <div className="px-3 py-2.5">
      {/* Row 1: repeat icon + name + status */}
      <div className="flex items-center gap-2">
        <Repeat
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground">
          {data.name}
        </span>
        <CycleStatusPill status={data.status} />
      </div>

      {/* Row 2: date range */}
      <div className="mt-1.5 flex items-center gap-1.5 text-meta text-muted-foreground">
        <span>
          {formatDate(data.startsAt, undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
        <span aria-hidden className="text-muted-foreground/40">
          →
        </span>
        <span>
          {formatDate(data.endsAt, undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
      </div>

      {/* Row 3: progress bar */}
      {data.total > 0 && (
        <>
          <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-subtle/60">
            <span
              className="h-full bg-ember"
              style={{ width: `${donePct}%` }}
              aria-hidden
            />
            <span
              className="h-full bg-warning/70"
              style={{ width: `${inFlightPct}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-1.5 flex items-center gap-3 text-meta text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-ember"
                aria-hidden
              />
              {data.counts.done} done
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-warning/70"
                aria-hidden
              />
              {data.counts.inFlight} in-flight
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-subtle"
                aria-hidden
              />
              {data.counts.planned} planned
            </span>
          </div>
        </>
      )}
      {data.total === 0 && (
        <div className="mt-2 text-meta text-muted-foreground/80">
          No issues planned
        </div>
      )}
    </div>
  );
}

function CycleStatusPill({ status }: { status: string }) {
  const tone =
    status === "ACTIVE"
      ? "border-ember/40 bg-ember/10 text-ember"
      : status === "PLANNED"
        ? "border-border bg-subtle/60 text-muted-foreground"
        : "border-border bg-subtle/60 text-muted-foreground/80";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider",
        tone,
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}
