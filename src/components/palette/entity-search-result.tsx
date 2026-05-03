"use client";
import {
  CircleDot,
  FolderKanban,
  Target,
  Filter,
  CalendarRange,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One result row inside the command palette. Discriminated by
 * `result.kind` so each entity type can render its own primary +
 * secondary text (issue: key + title + status; project: key + name;
 * etc.) without the parent palette having to switch on type.
 *
 * Selected state matches the row idiom used elsewhere in the
 * codebase: `bg-card/60` on hover or arrow-key focus, `text-foreground`
 * on the primary line, `.text-meta` (density-aware) on the secondary.
 *
 * `kbdHint` is rendered as a small monospace badge on the right —
 * used by the palette to show "↵" on the active row, or numeric
 * shortcuts on power-user keystrokes. Optional.
 *
 * Phase 0 ships this component; Phase 1C wires it into the palette
 * modal. Decoupled so the modal can be iterated without re-touching
 * row layout.
 */
export type EntitySearchResultData =
  | {
      kind: "issue";
      id: string;
      key: string;
      title: string;
      statusName: string;
      statusColor: string;
      projectKey?: string | null;
    }
  | {
      kind: "project";
      id: string;
      key: string;
      name: string;
      color?: string | null;
      icon?: string | null;
    }
  | {
      kind: "initiative";
      id: string;
      slug: string;
      name: string;
      color?: string | null;
      status: string;
    }
  | {
      kind: "savedView";
      id: string;
      name: string;
      workspaceName?: string;
    }
  | {
      kind: "cycle";
      id: string;
      name: string;
      status: string;
    }
  | {
      kind: "agent";
      id: string;
      profileKey: string;
      displayName: string;
      status: string;
    };

export function EntitySearchResult({
  result,
  selected = false,
  onSelect,
  kbdHint,
}: {
  result: EntitySearchResultData;
  selected?: boolean;
  onSelect: () => void;
  kbdHint?: string;
}) {
  const { Icon, primary, secondary, accent } = render(result);

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        "focus-ring flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left",
        selected ? "bg-card/60 text-foreground" : "text-foreground/90 hover:bg-subtle",
      )}
    >
      <span className="grid h-5 w-5 shrink-0 place-items-center text-muted-foreground">
        {accent ? (
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: accent }}
            aria-hidden
          />
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-xs",
          (result.kind === "issue" || result.kind === "project") && "font-mono",
        )}
      >
        {primary}
      </span>
      {secondary && (
        <span className="text-meta min-w-0 truncate text-muted-foreground">
          {secondary}
        </span>
      )}
      {kbdHint && (
        <span className="ml-auto rounded border border-border/60 bg-card/40 px-1 font-mono text-[0.625rem] text-muted-foreground">
          {kbdHint}
        </span>
      )}
    </button>
  );
}

function render(r: EntitySearchResultData): {
  Icon: React.ComponentType<{ className?: string }>;
  primary: string;
  secondary?: string;
  accent?: string;
} {
  switch (r.kind) {
    case "issue":
      return {
        Icon: CircleDot,
        primary: `${r.key} · ${r.title}`,
        secondary: r.projectKey ? `${r.statusName} · ${r.projectKey}` : r.statusName,
        accent: r.statusColor,
      };
    case "project":
      return {
        Icon: FolderKanban,
        primary: `${r.key} · ${r.name}`,
        accent: r.color ?? undefined,
      };
    case "initiative":
      return {
        Icon: Target,
        primary: r.name,
        secondary: r.status,
        accent: r.color ?? undefined,
      };
    case "savedView":
      return {
        Icon: Filter,
        primary: r.name,
        secondary: r.workspaceName,
      };
    case "cycle":
      return {
        Icon: CalendarRange,
        primary: r.name,
        secondary: r.status,
      };
    case "agent":
      return {
        Icon: Bot,
        primary: r.displayName,
        secondary: `@${r.profileKey} · ${r.status.toLowerCase()}`,
      };
  }
}
