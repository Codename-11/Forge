"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Pin as PinIcon,
  X,
  FolderKanban,
  Diamond,
  Filter,
  Repeat,
  Bot,
  CircleDot,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn, formatIssueId } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";
import { broadcastCrossTab, useCrossTab } from "@/hooks/use-realtime";
import { useMaybeWorkspace } from "@/hooks/use-workspace";
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

  const removeMut = trpc.pin.remove.useMutation({
    onSuccess: () => {
      void utils.pin.listAll.invalidate();
      void utils.pin.list.invalidate();
      broadcastCrossTab({ type: "pins:updated" });
      toast.success("Unpinned");
    },
    onError: (e) => toast.error(e.message),
  });

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
          return <EmptyPinSlot key={`empty-${idx}`} alreadyPinnedIds={pinnedKeySet(pins)} />;
        }
        return (
          <PinChip
            key={pin.id}
            pin={pin}
            onRemove={() => removeMut.mutate({ id: pin.id })}
            removing={removeMut.isPending}
          />
        );
      })}
    </div>
  );
}

function pinnedKeySet(pins: HydratedPin[]): Set<string> {
  const s = new Set<string>();
  for (const p of pins) s.add(`${p.targetType}:${p.targetId}`);
  return s;
}

/**
 * Clickable empty pin slot. Opens a small picker anchored beneath the
 * trigger, populated with the operator's recent items in the current
 * workspace. Selecting an item calls `pin.add` with
 * `workspaceId: null` so it lands in the cross-workspace strip.
 */
function EmptyPinSlot({ alreadyPinnedIds }: { alreadyPinnedIds: Set<string> }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Pin an item — issues, projects, sprints, agents…"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="focus-ring inline-flex h-7 min-w-[96px] items-center gap-1.5 rounded-md border border-dashed border-border/70 px-2 text-[0.6875rem] text-muted-foreground/60 transition-colors hover:border-foreground/40 hover:text-foreground hover:bg-subtle"
      >
        <PinIcon className="h-3 w-3" />
        <span>Pin…</span>
      </button>
      {open && (
        <PinPickerPopover
          alreadyPinnedIds={alreadyPinnedIds}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function PinPickerPopover({
  alreadyPinnedIds,
  onClose,
}: {
  alreadyPinnedIds: Set<string>;
  onClose: () => void;
}) {
  const ws = useMaybeWorkspace();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const recentsQ = trpc.recentItem.list.useQuery({ limit: 20 }, { enabled: !!ws });
  const items = useMemo(() => {
    const raw = (recentsQ.data ?? []) as HydratedPin[];
    const q = query.trim().toLowerCase();
    if (!q) return raw;
    return raw.filter((r) => labelFor(r.target).toLowerCase().includes(q));
  }, [recentsQ.data, query]);

  const addMut = trpc.pin.add.useMutation({
    onSuccess: () => {
      void utils.pin.listAll.invalidate();
      void utils.pin.list.invalidate();
      broadcastCrossTab({ type: "pins:updated" });
      toast.success("Pinned");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div
      role="dialog"
      aria-label="Pin an item"
      className="absolute left-0 top-[calc(100%+6px)] z-40 w-72 overflow-hidden rounded-md border border-border bg-card shadow-lg"
    >
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Filter recents…"
          className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {recentsQ.isLoading && (
          <li className="px-3 py-3 text-[0.6875rem] text-muted-foreground">Loading…</li>
        )}
        {!recentsQ.isLoading && items.length === 0 && (
          <li className="px-3 py-3 text-[0.6875rem] text-muted-foreground">
            {query ? "No matching recents." : "Nothing recent yet — open an item and come back."}
          </li>
        )}
        {items.map((r) => {
          const key = `${r.targetType}:${r.targetId}`;
          const already = alreadyPinnedIds.has(key);
          return (
            <li key={r.id}>
              <button
                type="button"
                disabled={already || addMut.isPending}
                onClick={() => {
                  addMut.mutate({
                    workspaceId: null,
                    targetType: r.targetType,
                    targetId: r.targetId,
                  });
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                  already
                    ? "cursor-not-allowed text-muted-foreground/60"
                    : "hover:bg-subtle",
                )}
                title={already ? "Already pinned" : "Pin to strip"}
              >
                <TargetIcon kind={r.targetType} />
                <span className="truncate flex-1">{labelFor(r.target)}</span>
                {already && <span className="text-[0.6875rem] text-muted-foreground">pinned</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function labelFor(t: HydratedPinTarget | null): string {
  if (!t) return "Unknown";
  switch (t.targetType) {
    case "ISSUE":
      return `${formatIssueId(t.workspaceKey, t.number)} ${t.title}`;
    case "PROJECT":
    case "INITIATIVE":
    case "CYCLE":
    case "AGENT":
      return t.name;
    case "SAVED_VIEW":
      return t.name;
  }
}

function TargetIcon({ kind }: { kind: HydratedPinTarget["targetType"] }) {
  switch (kind) {
    case "ISSUE":      return <CircleDot className="h-3 w-3 shrink-0 text-muted-foreground" />;
    case "PROJECT":    return <FolderKanban className="h-3 w-3 shrink-0 text-muted-foreground" />;
    case "INITIATIVE": return <Diamond className="h-3 w-3 shrink-0 text-muted-foreground" />;
    case "CYCLE":      return <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" />;
    case "SAVED_VIEW": return <Filter className="h-3 w-3 shrink-0 text-muted-foreground" />;
    case "AGENT":      return <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />;
  }
}

/**
 * Render a single pin as a type-appropriate compact chip. Each variant
 * keeps the same outer dimensions (`h-7`) so the strip stays a uniform
 * height regardless of which mix of pin types the user has.
 */
function PinChip({
  pin,
  onRemove,
  removing,
}: {
  pin: HydratedPin;
  onRemove: () => void;
  removing: boolean;
}) {
  if (!pin.target) return null;
  const label = labelFor(pin.target);
  return (
    <div className="group/pinned-strip relative inline-flex min-w-0">
      <PinChipLink target={pin.target} />
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        disabled={removing}
        title={`Unpin from navbar: ${label}`}
        aria-label={`Unpin from navbar: ${label}`}
        className="focus-ring absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-card hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function PinChipLink({ target }: { target: HydratedPinTarget }) {
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
  "focus-ring group inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-card/60 pl-1 pr-7 text-left hover:bg-subtle",
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

