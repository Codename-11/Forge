"use client";
import Link from "next/link";
import { Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Compact pill linking to a cycle (Sprint) detail page.
 *
 * UI nomenclature note: per CLAUDE.md (2026-04-24 rename) the cycle
 * primitive is surfaced as "Sprint" in the user-visible UI. The data
 * model, route (`/cycles`), and component file names stay `cycle*` —
 * only display strings shifted. So the chip's `name` should already
 * read as a sprint name when consumed; we don't auto-prefix.
 *
 * Slug resolution mirrors `ProjectChip` / `InitiativeChip`.
 */
export type CycleChipData = {
  id: string;
  name: string;
  status?: string | null;
};

export function CycleChip({
  cycle,
  slug,
  className,
}: {
  cycle: CycleChipData;
  /** Override the workspace slug. Falls back to the workspace context. */
  slug?: string;
  className?: string;
}) {
  const ws = useMaybeWorkspace();
  const resolvedSlug = slug ?? ws?.slug;
  const href = resolvedSlug
    ? `/w/${resolvedSlug}/cycles/${cycle.id}`
    : null;

  const body = (
    <>
      <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate text-xs text-foreground/90">
        {cycle.name}
      </span>
      {cycle.status === "ACTIVE" && (
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ember"
          aria-label="Active sprint"
        />
      )}
    </>
  );

  const chipClass = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 transition-colors",
    href && "hover:border-ember/40 hover:bg-card",
    className,
  );

  const titleText = `Sprint: ${cycle.name}${
    cycle.status === "ACTIVE" ? " (active)" : ""
  }`;

  if (!href) {
    return (
      <span className={chipClass} title={titleText}>
        {body}
      </span>
    );
  }

  return (
    <Link href={href} className={chipClass} title={titleText}>
      {body}
    </Link>
  );
}
