"use client";
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/**
 * Cycle + Initiative filter chips for the issue list / board / saved-view
 * payload. Tri-state semantics:
 *   undefined → no filter (chip label: "Any cycle" / "Any initiative")
 *   null      → explicitly match "none" (backlog / no initiative)
 *   string    → specific id
 */

export type CycleFilter = string | null | undefined;
export type InitiativeFilter = string | null | undefined;

export function CycleFilterChip({
  value,
  onChange,
}: {
  value: CycleFilter;
  onChange: (v: CycleFilter) => void;
}) {
  const { data: cycles } = trpc.cycle.list.useQuery({});
  const { data: currentCycle } = trpc.cycle.current.useQuery();

  const label = (() => {
    if (value === undefined) return "Any cycle";
    if (value === null) return "Backlog (no cycle)";
    if (value === currentCycle?.id) return `Current: ${currentCycle.name}`;
    const match = cycles?.find((c) => c.id === value);
    return match ? match.name : "Cycle";
  })();

  return (
    <Chip label={label} active={value !== undefined}>
      {(close) => (
        <ul className="min-w-[220px] py-1">
          <Option
            label="Any cycle"
            selected={value === undefined}
            onClick={() => {
              onChange(undefined);
              close();
            }}
          />
          {currentCycle && (
            <Option
              label={`Current cycle (${currentCycle.name})`}
              selected={value === currentCycle.id}
              onClick={() => {
                onChange(currentCycle.id);
                close();
              }}
            />
          )}
          <Option
            label="Backlog (no cycle)"
            selected={value === null}
            onClick={() => {
              onChange(null);
              close();
            }}
          />
          <li className="my-1 border-t border-border" />
          {cycles?.map((c) => (
            <Option
              key={c.id}
              label={c.name}
              selected={value === c.id}
              onClick={() => {
                onChange(c.id);
                close();
              }}
            />
          ))}
        </ul>
      )}
    </Chip>
  );
}

export function InitiativeFilterChip({
  value,
  onChange,
}: {
  value: InitiativeFilter;
  onChange: (v: InitiativeFilter) => void;
}) {
  const { data: initiatives } = trpc.initiative.list.useQuery({});

  const label = (() => {
    if (value === undefined) return "Any initiative";
    if (value === null) return "(No initiative)";
    const match = initiatives?.find((i) => i.id === value);
    return match ? match.name : "Initiative";
  })();

  return (
    <Chip label={label} active={value !== undefined}>
      {(close) => (
        <ul className="min-w-[220px] py-1">
          <Option
            label="Any initiative"
            selected={value === undefined}
            onClick={() => {
              onChange(undefined);
              close();
            }}
          />
          <Option
            label="(No initiative)"
            selected={value === null}
            onClick={() => {
              onChange(null);
              close();
            }}
          />
          <li className="my-1 border-t border-border" />
          {initiatives?.map((i) => (
            <Option
              key={i.id}
              label={i.name}
              selected={value === i.id}
              color={i.color}
              onClick={() => {
                onChange(i.id);
                close();
              }}
            />
          ))}
        </ul>
      )}
    </Chip>
  );
}

function Chip({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: (close: () => void) => React.ReactNode;
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
        className={cn(
          "focus-ring inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px]",
          active
            ? "border-ember/50 bg-ember/10 text-foreground"
            : "border-border bg-background/60 text-muted-foreground hover:bg-subtle/60",
        )}
      >
        {label}
        <span className="text-[9px] opacity-60">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-20 rounded-md border border-border bg-card shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Option({
  label,
  selected,
  onClick,
  color,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  color?: string | null;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-subtle",
          selected && "bg-subtle/60",
        )}
      >
        {color !== undefined && (
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: color ?? "#78716c" }}
          />
        )}
        <span className="truncate">{label}</span>
        {selected && <span className="ml-auto text-ember">✓</span>}
      </button>
    </li>
  );
}
