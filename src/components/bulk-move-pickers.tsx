"use client";
import { useState } from "react";
import { Picker } from "@/components/ui/modal";

/**
 * Shared bulk "move to…" pickers for project and sprint (cycle), used by
 * both the issues list and the inbox bulk bars. Each wraps the command
 * palette `Picker` with a "no project / no sprint" clear row; the server's
 * `issue.bulkSetProject` / `bulkSetCycle` enforce workspace scope, so the
 * picker just emits the chosen id (or null to clear).
 */

type ProjectRow =
  | { kind: "none"; key: string }
  | {
      kind: "project";
      key: string;
      id: string;
      name: string;
      color: string | null;
      initiativeName: string | null;
    };

export function BulkProjectPicker({
  open,
  onOpenChange,
  projects,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projects: Array<{
    id: string;
    name: string;
    color?: string | null;
    initiative?: { name: string } | null;
  }>;
  onPick: (projectId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items: ProjectRow[] = [
    { kind: "none", key: "__none" },
    ...projects
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (p.initiative?.name.toLowerCase().includes(q) ?? false),
      )
      .map((p) => ({
        kind: "project" as const,
        key: p.id,
        id: p.id,
        name: p.name,
        color: p.color ?? null,
        initiativeName: p.initiative?.name ?? null,
      })),
  ];
  return (
    <Picker<ProjectRow>
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Move selected to project… (name or initiative)"
      items={items}
      getKey={(it) => it.key}
      onQueryChange={setQuery}
      emptyLabel="No projects match."
      onSelect={(it) => onPick(it.kind === "none" ? null : it.id)}
      renderItem={(it) =>
        it.kind === "none" ? (
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted" />
            <span className="text-muted-foreground">No project</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: it.color ?? "var(--muted)" }}
            />
            <span className="truncate">{it.name}</span>
            {it.initiativeName && (
              <span className="ml-auto shrink-0 rounded bg-subtle px-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                {it.initiativeName}
              </span>
            )}
          </div>
        )
      }
    />
  );
}

type CycleRow =
  | { kind: "none"; key: string }
  | { kind: "cycle"; key: string; id: string; name: string; status: string };

export function BulkCyclePicker({
  open,
  onOpenChange,
  cycles,
  onPick,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cycles: Array<{ id: string; name: string; status: string }>;
  onPick: (cycleId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items: CycleRow[] = [
    { kind: "none", key: "__none" },
    ...cycles
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .map((c) => ({
        kind: "cycle" as const,
        key: c.id,
        id: c.id,
        name: c.name,
        status: c.status,
      })),
  ];
  return (
    <Picker<CycleRow>
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Move selected to sprint…"
      items={items}
      getKey={(it) => it.key}
      onQueryChange={setQuery}
      emptyLabel="No sprints match."
      onSelect={(it) => onPick(it.kind === "none" ? null : it.id)}
      renderItem={(it) =>
        it.kind === "none" ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">No sprint</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="truncate">{it.name}</span>
            <span className="ml-auto shrink-0 rounded bg-subtle px-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
              {it.status.toLowerCase()}
            </span>
          </div>
        )
      }
    />
  );
}
