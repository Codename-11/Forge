"use client";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Priority, StatusCategory } from "@prisma/client";
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
 * Multi-select facet chips for the issue list — Status, Priority,
 * Assignee, Label. Project is a first-class chip next to Sprint/Initiative
 * because operators filter by project constantly. Each facet is a chip +
 * popover of checkable options operating on the array fields of
 * `SavedViewFilters` (`statusIds`, `priorities`, `assigneeIds`, `labelIds`). Unlike the single-pick Sprint /
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
  const { data: labels } = trpc.label.list.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();

  const togglePriority = (p: Priority) => {
    const set = new Set(filters.priorities ?? []);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    const next = [...set];
    onChange({ ...filters, priorities: next.length ? next : undefined });
  };

  const toggleStatus = (id: string) => {
    const nextStatusIds = toggleId(filters.statusIds, id);
    const selectedTerminalStatus = (statuses ?? []).some(
      (s) =>
        nextStatusIds?.includes(s.id) &&
        (s.category === StatusCategory.DONE || s.category === StatusCategory.CANCELED),
    );
    const selectedTerminalCategory = filters.statusCategories?.some(
      (category) => category === StatusCategory.DONE || category === StatusCategory.CANCELED,
    );
    onChange({
      ...filters,
      statusIds: nextStatusIds,
      includeDone: selectedTerminalStatus || selectedTerminalCategory ? true : undefined,
    });
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
            onToggle={() => toggleStatus(s.id)}
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

/**
 * Shared keyboard behaviour for the chip popovers. Returns an `onKeyDown`
 * for the popover container (events bubble up from the trigger + options):
 *   - Escape closes and returns focus to the trigger
 *   - Arrow Up/Down rove between the option buttons
 * Plus a focus-on-open effect so opening a chip with the keyboard lands
 * focus inside the panel. Previously these popovers were mouse-only — no
 * Esc, no arrow nav, focus stranded on the trigger.
 */
function usePopoverKeys(
  open: boolean,
  setOpen: (v: boolean) => void,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  panelRef: React.RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open, panelRef]);

  return (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
      items[next]?.focus();
    }
  };
}

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  const onKeyDown = usePopoverKeys(open, setOpen, triggerRef, panelRef);

  const active = count > 0;
  return (
    <div ref={ref} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
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
        <div
          ref={panelRef}
          className="absolute left-0 top-[calc(100%+4px)] z-20 max-h-72 min-w-[220px] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md border border-border bg-card shadow-lg"
        >
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  const onKeyDown = usePopoverKeys(open, setOpen, triggerRef, panelRef);

  return (
    <div ref={ref} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
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
        <div
          ref={panelRef}
          className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[180px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
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
