"use client";

import Link from "next/link";
import { Settings2, Zap } from "lucide-react";
import type { AutoDispatchMode } from "@prisma/client";
import { cn } from "@/lib/utils";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * `DispatchModeBadge` — small chip that surfaces the workspace's
 * `autoDispatchMode` with a tooltip explaining the picker semantics.
 * Drops next to "Auto-dispatch: on / off" toggles in the agents UI so
 * operators can see at a glance how queued issues will be picked up.
 *
 * Settings affordance: clicking the gear navigates to
 * `/w/<slug>/settings/agents` (the existing dispatch settings surface
 * — same target the auto-dispatch toggle uses today).
 */
type Mode = AutoDispatchMode;

const COPY: Record<Mode, { label: string; tooltip: string; href: string }> = {
  MANUAL_ONLY: {
    label: "Manual only",
    tooltip:
      "Auto-dispatch is off. Operators assign agents manually; queued issues sit in the agent queue until someone picks.",
    href: "settings/agents",
  },
  ROUND_ROBIN: {
    label: "Round-robin",
    tooltip:
      "Picks the eligible agent whose last dispatch is the oldest. Agents at their concurrency cap are skipped.",
    href: "settings/agents",
  },
  PRIORITY_MATCH: {
    label: "Priority match",
    tooltip:
      "Prefers agents whose capabilities include the issue's priority tag (urgent, high…). Round-robin tie-break.",
    href: "settings/agents",
  },
  CAPABILITY_MATCH: {
    label: "Capability match",
    tooltip:
      "Picks the agent whose capability tags overlap the issue's labels by the largest count. Round-robin tie-break.",
    href: "settings/agents",
  },
};

export function DispatchModeBadge({
  mode,
  /**
   * When true, the gear icon is rendered as a link to the workspace's
   * agents-settings page. When false (default), the badge is read-only.
   */
  showSettingsLink = false,
  className,
}: {
  mode: Mode;
  showSettingsLink?: boolean;
  className?: string;
}) {
  const ws = useMaybeWorkspace();
  const copy = COPY[mode];

  return (
    <span
      title={copy.tooltip}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-2 py-1",
        className,
      )}
    >
      <Zap className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-meta whitespace-nowrap text-foreground/90">
        {copy.label}
      </span>
      {showSettingsLink && ws?.slug ? (
        <Link
          href={`/w/${ws.slug}/${copy.href}`}
          className="focus-ring rounded-sm text-muted-foreground hover:text-foreground"
          aria-label="Edit dispatch settings"
          title="Edit dispatch settings"
          onClick={(e) => e.stopPropagation()}
        >
          <Settings2 className="h-3 w-3" aria-hidden />
        </Link>
      ) : null}
    </span>
  );
}
