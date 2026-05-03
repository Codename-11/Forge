"use client";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
import { Kbd } from "@/components/ui/kbd";

/**
 * Prev / next chevrons for navigating between siblings of the current
 * issue. Scope picks which list defines siblings:
 *   - `project` — issues in the same project (or "no project" group)
 *   - `cycle`   — issues in the same cycle / sprint
 *
 * Calls `issue.siblings` (added in Phase 0) which respects the workspace
 * tenant scope and the same ordering used by `issue.list`. When either
 * end of the run is hit the corresponding chevron renders disabled — no
 * link, low-contrast, with `aria-disabled`. The `[` / `]` Kbd hints
 * mirror Linear's keyboard convention; Phase 1 will wire the actual
 * shortcuts in the issue-detail page.
 */
export function IssueSiblingNav({
  issueId,
  scope,
  className,
  showKbdHints = true,
}: {
  issueId: string;
  scope: "project" | "cycle";
  className?: string;
  /** Render the `[` / `]` Kbd hint pills next to the chevrons. */
  showKbdHints?: boolean;
}) {
  const ws = useMaybeWorkspace();
  const { data, isLoading } = trpc.issue.siblings.useQuery(
    { issueId, scope },
    { staleTime: 30_000 },
  );

  const prev = data?.prev ?? null;
  const next = data?.next ?? null;
  const slug = ws?.slug;

  const prevHref = prev && slug ? `/w/${slug}/issues/${prev.id}` : null;
  const nextHref = next && slug ? `/w/${slug}/issues/${next.id}` : null;

  return (
    <nav
      aria-label={`${scope === "project" ? "Project" : "Sprint"} sibling navigation`}
      className={cn("inline-flex items-center gap-1", className)}
    >
      <SiblingButton
        direction="prev"
        href={prevHref}
        sibling={prev}
        disabled={isLoading || !prev}
        showKbdHints={showKbdHints}
      />
      <SiblingButton
        direction="next"
        href={nextHref}
        sibling={next}
        disabled={isLoading || !next}
        showKbdHints={showKbdHints}
      />
    </nav>
  );
}

type SiblingShape = { id: string; key: string; title: string } | null;

function SiblingButton({
  direction,
  href,
  sibling,
  disabled,
  showKbdHints,
}: {
  direction: "prev" | "next";
  href: string | null;
  sibling: SiblingShape;
  disabled: boolean;
  showKbdHints: boolean;
}) {
  const Chevron = direction === "prev" ? ChevronLeft : ChevronRight;
  const hint = direction === "prev" ? "[" : "]";
  const label = sibling
    ? `${direction === "prev" ? "Previous" : "Next"} — ${sibling.key} ${sibling.title}`
    : `No ${direction === "prev" ? "previous" : "next"} issue`;

  const inner = (
    <span className="inline-flex items-center gap-1">
      {direction === "prev" && (
        <Chevron className="h-3.5 w-3.5" aria-hidden />
      )}
      {showKbdHints && (
        <Kbd className="hidden md:inline-flex">{hint}</Kbd>
      )}
      {direction === "next" && (
        <Chevron className="h-3.5 w-3.5" aria-hidden />
      )}
    </span>
  );

  const base =
    "inline-flex h-7 items-center gap-1 rounded-md border px-1.5 transition-colors";

  if (disabled || !href) {
    return (
      <span
        aria-disabled
        title={label}
        className={cn(
          base,
          "cursor-not-allowed border-border/50 bg-card/20 text-muted-foreground/40",
        )}
      >
        {inner}
      </span>
    );
  }

  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className={cn(
        base,
        "border-border bg-card/40 text-muted-foreground hover:border-ember/40 hover:text-foreground",
      )}
    >
      {inner}
    </Link>
  );
}
