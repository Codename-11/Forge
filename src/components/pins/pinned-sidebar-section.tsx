"use client";
import Link from "next/link";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  CircleDot,
  FolderKanban,
  Target,
  Filter,
  CalendarRange,
  Bot,
} from "lucide-react";
import { type PinTargetType } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { broadcastCrossTab } from "@/hooks/use-realtime";
import { IssueHoverPreview } from "@/components/issue-hover-preview";
import type { HydratedPin } from "@/server/routers/pin";

/**
 * Sidebar section rendering the user's pinned items for the current
 * workspace + the cross-workspace strip merged together. Workspace-
 * scoped pins come first (they're context-relevant); cross-workspace
 * pins follow underneath.
 *
 * Empty state: render nothing — no header, no copy. Phase 1 sidebar
 * code conditionally mounts this section, so a quiet empty state
 * collapses cleanly.
 *
 * Each row: small type-icon + identifier (mono for issues + projects,
 * sans for everything else) + truncated label. Hover reveals an unpin
 * × button on the right edge. Clicking the row navigates; clicking
 * the × removes the pin without navigating.
 */
const ICON_BY_TYPE: Record<PinTargetType, React.ComponentType<{ className?: string }>> = {
  ISSUE: CircleDot,
  PROJECT: FolderKanban,
  INITIATIVE: Target,
  SAVED_VIEW: Filter,
  CYCLE: CalendarRange,
  AGENT: Bot,
};

export function PinnedSidebarSection({
  workspaceId,
  workspaceSlug,
  collapsed = false,
}: {
  /** Current workspace id; used to fetch this-workspace pins. */
  workspaceId: string;
  /** Current workspace slug; used to build href fallbacks for pins
   *  whose target row didn't carry an explicit workspaceSlug. */
  workspaceSlug: string;
  /** Sidebar in icon-rail mode hides labels and the unpin affordance. */
  collapsed?: boolean;
}) {
  const utils = trpc.useUtils();
  // Two narrow queries instead of one wide one: cleaner cache
  // invalidation, and the cross-workspace strip refreshes when other
  // tabs broadcast `pins:updated` even if this workspace's list is
  // untouched.
  const wsPins = trpc.pin.listAll.useQuery({ workspaceId });
  const crossPins = trpc.pin.listAll.useQuery({ workspaceId: null });

  const remove = trpc.pin.remove.useMutation({
    onSuccess: () => {
      void utils.pin.listAll.invalidate();
      void utils.pin.list.invalidate();
      broadcastCrossTab({ type: "pins:updated" });
    },
    onError: (err) => toast.error(err.message),
  });

  const items: HydratedPin[] = [
    ...((wsPins.data ?? []) as HydratedPin[]),
    ...((crossPins.data ?? []) as HydratedPin[]),
  ];
  if (items.length === 0) return null;

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((p) => {
        if (!p.target) return null;
        const Icon = ICON_BY_TYPE[p.targetType];
        const href = pinHref(p, workspaceSlug);
        const label = pinLabel(p);
        const mono = p.targetType === "ISSUE" || p.targetType === "PROJECT";
        // Only wrap with hover-preview for ISSUE pins in the current
        // workspace — `issue.summary` is workspace-scoped and would
        // miss cross-workspace pins. Collapsed rail also skips hover
        // since the label / chip itself is hidden.
        const showIssuePreview =
          !collapsed &&
          p.target.targetType === "ISSUE" &&
          p.workspaceId === workspaceId;
        const rowLink = (
          <Link
            href={href}
            className={cn(
              "focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 hover:bg-subtle",
            )}
            title={label}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {!collapsed && (
              <span
                className={cn(
                  "min-w-0 truncate text-xs",
                  mono && "font-mono",
                )}
              >
                {label}
              </span>
            )}
          </Link>
        );
        return (
          <li
            key={p.id}
            className="group/pin relative flex items-center"
          >
            {showIssuePreview && p.target.targetType === "ISSUE" ? (
              <IssueHoverPreview
                issueKey={p.target.key}
                workspaceSlug={workspaceSlug}
                className="relative flex min-w-0 flex-1"
              >
                {rowLink}
              </IssueHoverPreview>
            ) : (
              rowLink
            )}
            {!collapsed && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  remove.mutate({ id: p.id });
                }}
                title="Unpin"
                aria-label={`Unpin ${label}`}
                className="focus-ring absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-card hover:text-foreground group-hover/pin:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Build the navigation target for a pin. Issues/projects/initiatives/
 *  cycles/views/agents each have their own routing convention. */
function pinHref(p: HydratedPin, fallbackSlug: string): string {
  const t = p.target;
  if (!t) return "#";
  const slug = t.workspaceSlug ?? fallbackSlug;
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
      return `/w/${slug}/agents/${t.profileKey}`;
  }
}

/** Compact label rendered in the sidebar row. Issue / project pins lead
 *  with their key (mono). The rest fall back to the entity's name. */
function pinLabel(p: HydratedPin): string {
  const t = p.target;
  if (!t) return "—";
  switch (t.targetType) {
    case "ISSUE":
      return `${t.key} · ${t.title}`;
    case "PROJECT":
      return `${t.key} · ${t.name}`;
    case "INITIATIVE":
      return t.name;
    case "SAVED_VIEW":
      return t.name;
    case "CYCLE":
      return t.name;
    case "AGENT":
      return t.name;
  }
}
