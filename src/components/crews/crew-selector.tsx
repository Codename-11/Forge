"use client";
import { useMemo } from "react";
import { UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { roleBreakdown } from "@/components/crews/role-chip";

/**
 * Reusable crew picker. A native `<select>` styled to match the warm
 * earthy form controls used elsewhere, plus a one-line summary of the
 * chosen crew (member count + role breakdown) beneath it.
 *
 * `value` is the selected crew id (or null for "no crew"). Lists active
 * crews via `agentCrew.list` — which already embeds members, so the role
 * summary needs no extra query.
 */
export function CrewSelector({
  value,
  onChange,
  allowNone = true,
  noneLabel = "No crew",
  disabled = false,
  className,
}: {
  value: string | null;
  onChange: (crewId: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { data } = trpc.agentCrew.list.useQuery({});
  const crews = useMemo(() => data?.items ?? [], [data]);
  const selected = useMemo(
    () => crews.find((c) => c.id === value) ?? null,
    [crews, value],
  );

  const summary = selected
    ? `${selected.members.length} member${selected.members.length === 1 ? "" : "s"}${
        selected.members.length ? ` · ${roleBreakdown(selected.members)}` : ""
      }`
    : null;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="relative">
        <UsersRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <select
          value={value ?? ""}
          disabled={disabled || crews.length === 0}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full rounded-md border border-border bg-card/40 py-2 pl-8 pr-3 text-sm disabled:opacity-50"
        >
          {allowNone ? <option value="">{noneLabel}</option> : null}
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {summary ? (
        <p className="pl-1 text-meta text-muted-foreground">{summary}</p>
      ) : crews.length === 0 ? (
        <p className="pl-1 text-meta text-muted-foreground">
          No crews yet. Create one under Crews.
        </p>
      ) : null}
    </div>
  );
}
