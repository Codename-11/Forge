"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Priority } from "@prisma/client";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import {
  ISSUE_GROUP_VALUES,
  ISSUE_SORT_VALUES,
  type IssueGroupBy,
  type IssueSort,
  type SavedViewFilters,
} from "@/lib/saved-view-filters";

/**
 * Multi-select facet chips for the issue list — Status, Priority, Project,
 * Assignee, Label. Each is a chip + popover of checkable options operating
 * on the array fields of `SavedViewFilters` (`statusIds`, `priorities`,
 * `projectIds`, `assigneeIds`, `labelIds`). Unlike the single-pick Sprint /
 * Initiative chips, picking an option toggles it and KEEPS the popover open
 * so the operator can stack several without re-opening.
 *
 * The server (`issue.list`) already accepts every one of these arrays —
 * this just surfaces them, projecting onto the same `SavedViewFilters`
 * blob the page owns so a saved view captures the selection faithfully.
 */

const PRIORITY_OPTIONS: Priority[] = [
  Priority.URGENT,
  Priority.HIGH,
  Priority.MEDIUM,
  Priority.LOW,
  Priority.NONE,
];

function priorityLabel(p: Priority): string {
  return p.charAt(0) + p.slice(1).toLowerCase();
}

/** Toggle a string id within an optional array; empty collapses to undefined. */
function toggleId(
  arr: readonly string[] | undefined,
  id: string,
): string[] | undefined {
  const set = new Set(arr ?? []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  const next = [...set];
  return next.length ? next : undefined;
}

export function IssueFacetChips({
  filters,
  onChange,
}: {
  filters: SavedViewFilters;
  onChange: (next: SavedViewFilters) => void;
}) {
  const { data: statuses } = trpc.status.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery({
    archived: false,
    limit: 100,
  });
  const { data: labels } = trpc.label.list.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();

  const togglePriority = (p: Priority) => {
    const set = new Set(filters.priorities ?? []);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    const next = [...set];
    onChange({ ...filters, priorities: next.length ? next : undefined });
  };

  return (
    <>
      <FacetChip label="Status" count={filters.statusIds?.length ?? 0}>
        {(statuses ?? []).map((s) => (
          <CheckOption
            key={s.id}
            label={s.name}
            color={s.color}
            checked={filters.statusIds?.includes(s.id) ?? false}
            onToggle={() =>
              onChange({ ...filters, statusIds: toggleId(filters.statusIds, s.id) })
            }
          />
        ))}
      </FacetChip>

      <FacetChip label="Priority" count={filters.priorities?.length ?? 0}>
        {PRIORITY_OPTIONS.map((p) => (
          <CheckOption
            key={p}
            label={priorityLabel(p)}
            checked={filters.priorities?.includes(p) ?? false}
            onToggle={() => togglePriority(p)}
          />
        ))}
      </FacetChip>

      <FacetChip label="Project" count={filters.projectIds?.length ?? 0}>
        {(projects?.items ?? []).map((p) => (
          <CheckOption
            key={p.id}
            label={p.name}
            color={p.color}
            checked={filters.projectIds?.includes(p.id) ?? false}
            onToggle={() =>
              onChange({
                ...filters,
                projectIds: toggleId(filters.projectIds, p.id),
              })
            }
          />
        ))}
      </FacetChip>

      <FacetChip label="Assignee" count={filters.assigneeIds?.length ?? 0}>
        {(members ?? []).map((m) => (
          <CheckOption
            key={m.user.id}
            label={m.user.name ?? m.user.handle ?? m.user.email ?? "Member"}
            checked={filters.assigneeIds?.includes(m.user.id) ?? false}
            onToggle={() =>
              onChange({
                ...filters,
                assigneeIds: toggleId(filters.assigneeIds, m.user.id),
              })
            }
          />
        ))}
      </FacetChip>

      <FacetChip label="Label" count={filters.labelIds?.length ?? 0}>
        {(labels ?? []).map((l) => (
          <CheckOption
            key={l.id}
            label={l.name}
            color={l.color}
            checked={filters.labelIds?.includes(l.id) ?? false}
            onToggle={() =>
              onChange({ ...filters, labelIds: toggleId(filters.labelIds, l.id) })
            }
          />
        ))}
      </FacetChip>
    </>
  );
}

/**
 * Sort control — single-pick, closes on selection. Threaded into
 * `issue.list` as `sort` (a view preference, not a saved-view filter).
 */
export function SortChip({
  value,
  onChange,
}: {
  value: IssueSort;
  onChange: (v: IssueSort) => void;
}) {
  const LABELS: Record<IssueSort, string> = {
    priority: "Priority",
    newest: "Newest",
    oldest: "Oldest",
    updated: "Recently updated",
    title: "Title A–Z",
  };
  return (
    <SelectChip
      label={`Sort: ${LABELS[value]}`}
      active={value !== "priority"}
      options={ISSUE_SORT_VALUES.map((v) => ({ value: v, label: LABELS[v] }))}
      value={value}
      onChange={onChange}
    />
  );
}

/** Group-by control — single-pick, list view only. */
export function GroupChip({
  value,
  onChange,
}: {
  value: IssueGroupBy;
  onChange: (v: IssueGroupBy) => void;
}) {
  const LABELS: Record<IssueGroupBy, string> = {
    status: "Status",
    project: "Project",
    assignee: "Assignee",
    priority: "Priority",
    none: "None",
  };
  return (
    <SelectChip
      label={`Group: ${LABELS[value]}`}
      active={value !== "status"}
      options={ISSUE_GROUP_VALUES.map((v) => ({ value: v, label: LABELS[v] }))}
      value={value}
      onChange={onChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A facet chip whose popover stays open across multiple toggles. */
function FacetChip({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const active = count > 0;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "focus-ring inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[0.6875rem]",
          active
            ? "border-ember/50 bg-ember/10 text-foreground"
            : "border-border bg-background/60 text-muted-foreground hover:bg-subtle/60",
        )}
      >
        {label}
        {active && (
          <span className="rounded-full bg-ember/20 px-1 tabular-nums text-ember">
            {count}
          </span>
        )}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 max-h-72 min-w-[220px] overflow-y-auto rounded-md border border-border bg-card shadow-lg">
          <ul className="py-1">{children}</ul>
        </div>
      )}
    </div>
  );
}

function CheckOption({
  label,
  checked,
  onToggle,
  color,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  color?: string | null;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle"
      >
        <span
          className={cn(
            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
            checked ? "border-ember bg-ember/20" : "border-border",
          )}
        >
          {checked && <Check className="h-2.5 w-2.5 text-ember" aria-hidden />}
        </span>
        {color !== undefined && (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: color ?? "#78716c" }}
            aria-hidden
          />
        )}
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

/** A single-pick chip that closes on selection (Sort / Group). */
function SelectChip<T extends string>({
  label,
  active,
  options,
  value,
  onChange,
}: {
  label: string;
  active: boolean;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "focus-ring inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[0.6875rem]",
          active
            ? "border-ember/50 bg-ember/10 text-foreground"
            : "border-border bg-background/60 text-muted-foreground hover:bg-subtle/60",
        )}
      >
        {label}
        <ChevronDown className="h-2.5 w-2.5 opacity-60" aria-hidden />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[180px] overflow-hidden rounded-md border border-border bg-card shadow-lg">
          <ul className="py-1">
            {options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[0.75rem] hover:bg-subtle",
                    value === o.value && "bg-subtle/60",
                  )}
                >
                  <span className="flex-1 truncate">{o.label}</span>
                  {value === o.value && (
                    <Check className="h-3 w-3 text-ember" aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
