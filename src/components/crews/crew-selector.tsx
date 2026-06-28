"use client";
import { useMemo } from "react";
import { UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { Combobox } from "@/components/ui/combobox";
import { roleBreakdown } from "@/components/crews/role-chip";

/**
 * Reusable crew picker. Uses the themed in-app `Combobox` (no native
 * browser dropdown) to match the warm earthy form controls used
 * elsewhere, plus a one-line summary of the chosen crew (member count +
 * role breakdown) beneath it.
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
      <Combobox
        value={value}
        onChange={onChange}
        options={crews.map((c) => ({ value: c.id, label: c.name }))}
        allowNone={allowNone}
        noneLabel={noneLabel}
        placeholder={noneLabel}
        searchable={crews.length > 8}
        searchPlaceholder="Search crews…"
        disabled={disabled || crews.length === 0}
        matchTriggerWidth
        ariaLabel="Crew"
        className="w-full bg-card/40 py-2"
        leadingIcon={
          <UsersRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        }
      />
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
