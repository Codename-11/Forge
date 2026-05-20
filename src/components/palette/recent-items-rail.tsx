"use client";
import Link from "next/link";
import {
  CircleDot,
  FolderKanban,
  Target,
  Filter,
  CalendarRange,
  Bot,
} from "lucide-react";
import { type PinTargetType } from "@prisma/client";
import { cn } from "@/lib/utils";
import { IssueHoverPreview } from "@/components/issue-hover-preview";
import type { HydratedPin } from "@/server/routers/pin";

/**
 * Compact horizontal list of the user's most-recently-visited entities
 * in the current workspace. Used by the command palette empty-state
 * (when query is empty, render recents + pins as a quick-reach list)
 * and potentially by the dashboard / sidebar.
 *
 * Each chip = small type-icon + truncated label. Click navigates to
 * the entity's detail page. Capped to ~6 visually so the rail stays
 * single-line on most viewports — callers that want more should use a
 * vertical list.
 *
 * Data is consumer-supplied via the `items` prop so the rail can be
 * tested independently and so callers can pre-merge pins into the
 * list (or de-dup against pins) before passing in.
 */
const ICON_BY_TYPE: Record<PinTargetType, React.ComponentType<{ className?: string }>> = {
  ISSUE: CircleDot,
  PROJECT: FolderKanban,
  INITIATIVE: Target,
  SAVED_VIEW: Filter,
  CYCLE: CalendarRange,
  AGENT: Bot,
};

export function RecentItemsRail({
  items,
  workspaceSlug,
  limit = 6,
  className,
  onSelect,
}: {
  items: HydratedPin[];
  /** Used as a fallback when an item's target doesn't carry its own slug. */
  workspaceSlug: string;
  limit?: number;
  className?: string;
  /** When provided, the rail calls this instead of navigating via Link.
   *  Lets the palette dispatch on chip click without firing a hard route
   *  change inside its own dialog. */
  onSelect?: (item: HydratedPin) => void;
}) {
  const visible = items.filter((i) => i.target).slice(0, limit);
  if (visible.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {visible.map((p) => {
        if (!p.target) return null;
        const Icon = ICON_BY_TYPE[p.targetType];
        const slug = p.target.workspaceSlug ?? workspaceSlug;
        const href = chipHref(p, slug);
        const label = chipLabel(p);
        const inner = (
          <>
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="max-w-[160px] truncate text-xs">{label}</span>
          </>
        );
        const className =
          "focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1 hover:border-ember/40 hover:bg-card";
        if (onSelect) {
          return (
            <button
              key={p.id}
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onSelect(p);
              }}
              title={label}
              className={className}
            >
              {inner}
            </button>
          );
        }
        // Only wrap ISSUE chips in the current workspace — `issue.summary`
        // is workspace-scoped and would NOT_FOUND on cross-workspace pins.
        const showIssuePreview =
          p.target.targetType === "ISSUE" &&
          p.target.workspaceSlug === workspaceSlug;
        const chip = (
          <Link key={p.id} href={href} title={label} className={className}>
            {inner}
          </Link>
        );
        if (showIssuePreview && p.target.targetType === "ISSUE") {
          return (
            <IssueHoverPreview
              key={p.id}
              issueKey={p.target.key}
              workspaceSlug={slug}
              className="relative inline-flex"
            >
              {chip}
            </IssueHoverPreview>
          );
        }
        return chip;
      })}
    </div>
  );
}

function chipHref(p: HydratedPin, slug: string): string {
  const t = p.target;
  if (!t) return "#";
  switch (t.targetType) {
    case "ISSUE":
      return `/w/${slug}/issues/${t.id}`;
    case "PROJECT":
      return `/w/${slug}/projects/${t.id}`;
    case "INITIATIVE":
      return `/w/${slug}/initiatives/${t.slug}`;
    case "SAVED_VIEW":
      return `/w/${slug}/issues?view=${t.id}`;
    case "CYCLE":
      return `/w/${slug}/cycles/${t.id}`;
    case "AGENT":
      return `/w/${slug}/agents/${t.id}`;
  }
}

function chipLabel(p: HydratedPin): string {
  const t = p.target;
  if (!t) return "—";
  switch (t.targetType) {
    case "ISSUE":
      return `${t.key}`;
    case "PROJECT":
      return t.key;
    case "INITIATIVE":
    case "SAVED_VIEW":
    case "CYCLE":
      return t.name;
    case "AGENT":
      return t.name;
  }
}
