"use client";
import { CircleSlash, Inbox, ShieldAlert, Sparkles } from "lucide-react";
import { StatusCategory } from "@prisma/client";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import type { SavedViewFilters } from "@/lib/saved-view-filters";

/**
 * Built-in quick-filter chips above the issue list.
 *
 * Visual contract: square / solid pill with a leading glyph. Distinct
 * from the rounded outline saved-view chips so the row never reads as
 * a single homogeneous filter strip. Active toggles light up with the
 * ember tint; inactive sit on a translucent paper background.
 *
 * The chips are **not** mutually exclusive — clicking multiple stacks
 * the predicates. State is owned by the parent (the /issues page) and
 * applied through `onChange`.
 *
 * Backlog statuses (used by "My backlog") resolve via the workspace's
 * `status.list` filtered to BACKLOG / TODO categories. We pass the
 * resolved ids on the wire rather than category strings so the saved
 * view, if persisted, points at concrete rows the workspace owns.
 */
export function QuickFilterChips({
  filters,
  onChange,
  meId,
}: {
  filters: SavedViewFilters;
  onChange: (next: SavedViewFilters) => void;
  /** The current user's id; used by "My backlog". Undefined → chip is disabled. */
  meId: string | undefined;
}) {
  const { data: statuses } = trpc.status.list.useQuery();

  // "Backlog" statuses = BACKLOG + TODO category. Settings-driven via
  // the workspace's own status definitions — Phase 1D doesn't need a
  // dedicated "backlog category" column on Workspace yet because the
  // category enum already serves that role.
  const backlogStatusIds = (statuses ?? [])
    .filter(
      (s) =>
        s.category === StatusCategory.BACKLOG ||
        s.category === StatusCategory.TODO,
    )
    .map((s) => s.id);

  // -- Predicate helpers — derive `active` and `toggle` per chip from
  //    the parent's filters object. We compare against the canonical
  //    saved-view shape so the chips stay in sync when a saved view is
  //    applied (the chip lights up if its predicate is contained).

  // Unassigned
  const unassignedActive = filters.unassigned === true;
  const toggleUnassigned = () => {
    onChange({ ...filters, unassigned: unassignedActive ? undefined : true });
  };

  // My backlog
  const myBacklogActive =
    !!meId &&
    !!filters.assigneeIds?.includes(meId) &&
    backlogStatusIds.length > 0 &&
    backlogStatusIds.every((id) => filters.statusIds?.includes(id));
  const toggleMyBacklog = () => {
    if (!meId) return;
    if (myBacklogActive) {
      const nextAssignees = (filters.assigneeIds ?? []).filter(
        (id) => id !== meId,
      );
      const nextStatuses = (filters.statusIds ?? []).filter(
        (id) => !backlogStatusIds.includes(id),
      );
      onChange({
        ...filters,
        assigneeIds: nextAssignees.length ? nextAssignees : undefined,
        statusIds: nextStatuses.length ? nextStatuses : undefined,
      });
    } else {
      const nextAssignees = Array.from(
        new Set([...(filters.assigneeIds ?? []), meId]),
      );
      const nextStatuses = Array.from(
        new Set([...(filters.statusIds ?? []), ...backlogStatusIds]),
      );
      onChange({
        ...filters,
        assigneeIds: nextAssignees,
        statusIds: nextStatuses.length ? nextStatuses : undefined,
      });
    }
  };

  // Blocked
  const blockedActive = filters.blocked === true;
  const toggleBlocked = () => {
    onChange({ ...filters, blocked: blockedActive ? undefined : true });
  };

  // Recently updated (3d window)
  const updatedActive = filters.updatedSince === "3d";
  const toggleUpdated = () => {
    onChange({
      ...filters,
      updatedSince: updatedActive ? undefined : "3d",
    });
  };

  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      <li>
        <Chip
          active={unassignedActive}
          onClick={toggleUnassigned}
          icon={<Inbox className="h-3 w-3" aria-hidden />}
          label="Unassigned"
        />
      </li>
      <li>
        <Chip
          active={myBacklogActive}
          onClick={toggleMyBacklog}
          disabled={!meId || backlogStatusIds.length === 0}
          icon={<CircleSlash className="h-3 w-3" aria-hidden />}
          label="My backlog"
          title={
            !meId
              ? "Sign in to filter to your backlog"
              : backlogStatusIds.length === 0
                ? "Workspace has no backlog/todo statuses configured"
                : undefined
          }
        />
      </li>
      <li>
        <Chip
          active={blockedActive}
          onClick={toggleBlocked}
          icon={<ShieldAlert className="h-3 w-3" aria-hidden />}
          label="Blocked"
        />
      </li>
      <li>
        <Chip
          active={updatedActive}
          onClick={toggleUpdated}
          icon={<Sparkles className="h-3 w-3" aria-hidden />}
          label="Recently updated"
        />
      </li>
    </ul>
  );
}

function Chip({
  active,
  onClick,
  icon,
  label,
  disabled,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        "focus-ring inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-meta transition-colors",
        active
          ? "border-ember/60 bg-ember/15 text-foreground"
          : "border-border/80 bg-background/40 text-muted-foreground hover:border-ember/30 hover:bg-subtle/60 hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        className={cn(
          "flex h-3 w-3 items-center justify-center",
          active ? "text-ember" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      {label}
    </button>
  );
}
