"use client";
import Link from "next/link";
import {
  Pin as PinIcon,
  FolderKanban,
  Diamond,
  Filter,
  Repeat,
  Bot,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";
import { useCrossTab } from "@/hooks/use-realtime";
import { MOTION } from "@/lib/motion";
import type { HydratedPin, HydratedPinTarget } from "@/server/routers/pin";

/**
 * Cross-workspace personal pins strip, rendered in the workspace shell
 * top-bar. Up to 3 slots — empty slots render a subtle placeholder so
 * users can see the surface is pinnable.
 *
 * Phase 1A: switched from the legacy issue-only `pin.list` query to the
 * polymorphic `pin.listAll({ workspaceId: null })`. Each slot is now
 * type-aware: issues render with the workspace badge + mono key, projects
 * / initiatives / cycles / saved views / agents render with type-specific
 * compact chips. The 3-pin cap is preserved deliberately as a visual
 * budget — overflow lives in the sidebar pinned section.
 *
 * Legacy `pin.list` / MCP `pins.list` continue to work for Hermes
 * runtimes; the strip just stops calling them internally.
 */
const MAX_SLOTS = 3;

export function PinsStrip() {
  const utils = trpc.useUtils();
  const { data } = trpc.pin.listAll.useQuery({ workspaceId: null });
  const pins = (data ?? []) as HydratedPin[];

  // If another tab toggles a pin, refresh our cached list so the strip
  // stays consistent across windows. Pins are user-scoped (not tied to
  // a single workspace) so the BroadcastChannel is the right bus here;
  // the SSE stream is per-workspace and wouldn't reach a different tab
  // sitting on a different workspace.
  useCrossTab((msg) => {
    if (msg.type === "pins:updated") {
      void utils.pin.listAll.invalidate();
      void utils.pin.list.invalidate();
    }
  });

  const slots: (HydratedPin | null)[] = [...pins.slice(0, MAX_SLOTS)];
  while (slots.length < MAX_SLOTS) slots.push(null);

  return (
    <div className="hidden items-center gap-1 md:flex">
      {slots.map((pin, idx) => {
        if (!pin || !pin.target) {
          return (
            <div
              key={`empty-${idx}`}
              className="inline-flex h-7 min-w-[96px] items-center gap-1.5 rounded-md border border-dashed border-border/70 px-2 text-[0.6875rem] text-muted-foreground/60"
              title="Pin items from anywhere — issues, projects, sprints, agents…"
            >
              <PinIcon className="h-3 w-3" />
              <span>Pin…</span>
            </div>
          );
        }
        return <PinChip key={pin.id} target={pin.target} />;
      })}
    </div>
  );
}

/**
 * Render a single pin as a type-appropriate compact chip. Each variant
 * keeps the same outer dimensions (`h-7`) so the strip stays a uniform
 * height regardless of which mix of pin types the user has.
 */
function PinChip({ target }: { target: HydratedPinTarget }) {
  switch (target.targetType) {
    case "ISSUE":
      return <IssueChip target={target} />;
    case "PROJECT":
      return <ProjectStripChip target={target} />;
    case "INITIATIVE":
      return <InitiativeStripChip target={target} />;
    case "SAVED_VIEW":
      return <SavedViewStripChip target={target} />;
    case "CYCLE":
      return <CycleStripChip target={target} />;
    case "AGENT":
      return <AgentStripChip target={target} />;
  }
}

const STRIP_BASE = cn(
  "focus-ring group inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-card/60 pl-1 pr-2 text-left hover:bg-subtle",
  MOTION.base,
);

function IssueChip({ target }: { target: HydratedPinTarget & { targetType: "ISSUE" } }) {
  const badge = workspaceColor(target.workspaceKey);
  const href = `/w/${target.workspaceSlug}/issues/${target.id}`;
  const idLabel = formatIssueId(target.workspaceKey, target.number);
  return (
    <Link
      href={href}
      title={`${idLabel} · ${target.title}`}
      className={STRIP_BASE}
    >
      <span
        className="grid h-5 w-5 shrink-0 place-items-center rounded-sm font-mono text-[0.6875rem] font-semibold"
        style={{
          backgroundColor: badge.bg,
          color: badge.fg,
          boxShadow: `inset 0 0 0 1px ${badge.ring}`,
        }}
      >
        {target.workspaceKey.slice(0, 2)}
      </span>
      <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
        {idLabel}
      </span>
      <span className="truncate text-[0.6875rem]">{target.title}</span>
    </Link>
  );
}

function ProjectStripChip({
  target,
}: {
  target: HydratedPinTarget & { targetType: "PROJECT" };
}) {
  const href = `/w/${target.workspaceSlug}/projects/${target.id}`;
  return (
    <Link
      href={href}
      title={`${target.key} · ${target.name}`}
      className={STRIP_BASE}
    >
      {target.icon ? (
        <span aria-hidden className="text-[0.75rem] leading-none">
          {target.icon}
        </span>
      ) : target.color ? (
        <span
          aria-hidden
          className="inline-block h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: target.color }}
        />
      ) : (
        <FolderKanban
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-hidden
        />
      )}
      <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
        {target.key}
      </span>
      <span className="truncate text-[0.6875rem]">{target.name}</span>
    </Link>
  );
}

function InitiativeStripChip({
  target,
}: {
  target: HydratedPinTarget & { targetType: "INITIATIVE" };
}) {
  const href = `/w/${target.workspaceSlug}/initiatives/${target.slug}`;
  return (
    <Link href={href} title={target.name} className={STRIP_BASE}>
      <Diamond
        className="h-3 w-3 shrink-0"
        style={{ color: target.color ?? undefined }}
        fill={target.color ?? "currentColor"}
        aria-hidden
      />
      <span className="truncate text-[0.6875rem]">{target.name}</span>
    </Link>
  );
}

function SavedViewStripChip({
  target,
}: {
  target: HydratedPinTarget & { targetType: "SAVED_VIEW" };
}) {
  // Saved views render under the issues page with the view applied via
  // `?view=<id>`. The leading filter glyph mirrors the SavedViewsBar.
  const href = `/w/${target.workspaceSlug}/issues?view=${target.id}`;
  return (
    <Link
      href={href}
      title={`Saved view: ${target.name}`}
      className={STRIP_BASE}
    >
      <Filter className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate text-[0.6875rem]">{target.name}</span>
    </Link>
  );
}

function CycleStripChip({
  target,
}: {
  target: HydratedPinTarget & { targetType: "CYCLE" };
}) {
  const href = `/w/${target.workspaceSlug}/cycles/${target.id}`;
  return (
    <Link
      href={href}
      title={`Sprint: ${target.name}`}
      className={STRIP_BASE}
    >
      <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate text-[0.6875rem]">{target.name}</span>
      {target.status === "ACTIVE" && (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-ember"
        />
      )}
    </Link>
  );
}

function AgentStripChip({
  target,
}: {
  target: HydratedPinTarget & { targetType: "AGENT" };
}) {
  const href = `/w/${target.workspaceSlug}/agents/${target.profileKey}`;
  return (
    <Link href={href} title={target.name} className={STRIP_BASE}>
      <Bot className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate text-[0.6875rem]">{target.name}</span>
      <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
        @{target.profileKey}
      </span>
    </Link>
  );
}

