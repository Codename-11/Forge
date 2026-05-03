"use client";
import Link from "next/link";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Compact pill linking to a project's detail page. Renders the project's
 * key in mono (uppercase identifier) and the name in sans, separated by a
 * thin rule. Folder glyph on the left is decorative — it carries the
 * "this is a project" semantic so the chip reads as a project even when
 * sitting next to an InitiativeChip / CycleChip.
 *
 * Slug resolution: the chip prefers the workspace context (the standard
 * pattern in this codebase — see `initiative-card.tsx`). Callers rendering
 * outside `/w/[slug]/*` (RSC layouts, email previews) can pass `slug`
 * explicitly to override.
 */
export type ProjectChipData = {
  id: string;
  key: string;
  name: string;
  color?: string | null;
  icon?: string | null;
};

export function ProjectChip({
  project,
  slug,
  className,
}: {
  project: ProjectChipData;
  /** Override the workspace slug. Falls back to the workspace context. */
  slug?: string;
  className?: string;
}) {
  const ws = useMaybeWorkspace();
  const resolvedSlug = slug ?? ws?.slug;
  const href = resolvedSlug
    ? `/w/${resolvedSlug}/projects/${project.id}`
    : null;

  const dot = (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-sm"
      style={{ backgroundColor: project.color ?? "#a8a29e" }}
      aria-hidden
    />
  );

  const body = (
    <>
      {project.icon ? (
        <span className="text-id shrink-0" aria-hidden>
          {project.icon}
        </span>
      ) : project.color ? (
        dot
      ) : (
        <Folder className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="text-id shrink-0 font-mono text-foreground/90">
        {project.key}
      </span>
      <span aria-hidden className="text-muted-foreground/40">
        ·
      </span>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {project.name}
      </span>
    </>
  );

  const chipClass = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 transition-colors",
    href && "hover:border-ember/40 hover:bg-card",
    className,
  );

  if (!href) {
    return (
      <span className={chipClass} title={`${project.key} · ${project.name}`}>
        {body}
      </span>
    );
  }

  return (
    <Link href={href} className={chipClass} title={`${project.name} (open in project)`}>
      {body}
    </Link>
  );
}
