"use client";
import Link from "next/link";
import { Diamond } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Compact pill linking to an initiative detail page. Visually distinct
 * from `ProjectChip` via a leading diamond glyph (matches the "umbrella
 * above projects" semantic — initiatives are strategic, projects are
 * operational). Sans for the name; no key column since initiatives
 * don't have an issue prefix.
 *
 * Slug resolution mirrors `ProjectChip`: prefer the workspace context,
 * allow `slug` override for rendering outside `/w/[slug]/*`.
 */
export type InitiativeChipData = {
  id: string;
  slug: string;
  name: string;
  color?: string | null;
  status?: string | null;
};

export function InitiativeChip({
  initiative,
  slug,
  className,
}: {
  initiative: InitiativeChipData;
  /** Override the workspace slug. Falls back to the workspace context. */
  slug?: string;
  className?: string;
}) {
  const ws = useMaybeWorkspace();
  const resolvedSlug = slug ?? ws?.slug;
  const href = resolvedSlug
    ? `/w/${resolvedSlug}/initiatives/${initiative.slug}`
    : null;

  const body = (
    <>
      <Diamond
        className="h-3 w-3 shrink-0"
        style={{
          color: initiative.color ?? undefined,
        }}
        fill={initiative.color ?? "currentColor"}
        aria-hidden
      />
      <span className="min-w-0 truncate text-xs text-foreground/90">
        {initiative.name}
      </span>
    </>
  );

  const chipClass = cn(
    "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 transition-colors",
    href && "hover:border-ember/40 hover:bg-card",
    className,
  );

  const titleText = initiative.status
    ? `${initiative.name} · ${initiative.status}`
    : initiative.name;

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
