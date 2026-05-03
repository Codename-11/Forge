"use client";
import { Pin as PinIcon } from "lucide-react";
import { toast } from "sonner";
import { type PinTargetType } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { broadcastCrossTab } from "@/hooks/use-realtime";
import { MOTION } from "@/lib/motion";

/**
 * Generic pin/unpin toggle button — renders for any pinnable entity
 * (issue / project / initiative / saved view / cycle / agent). Distinct
 * from the legacy `<PinToggleButton />` (which is issue-only and uses
 * the `p` keyboard shortcut + the cross-workspace `pin.list` cache).
 *
 * The button reads `pin.listAll({ workspaceId, targetType })` to know
 * its current pinned state, calls `pin.toggleEntity` on click, and
 * optimistically flips the visual so users see instant feedback.
 *
 * Visual: outline pushpin when unpinned, filled (ember-tinted) when
 * pinned. Density matches `<RowQuickActions />` icon-button row
 * (h-6 w-6 by default; h-7 w-7 when `size="md"`).
 *
 * Pass `workspaceId = null` to pin to the cross-workspace strip
 * (matches the legacy issue strip semantic). Pass `workspaceId =
 * <id>` to pin within a specific workspace's sidebar. Omit (or
 * `undefined`) for the most common case — the current workspace —
 * but the component itself doesn't infer that, callers thread it.
 */
export function PinButton({
  targetType,
  targetId,
  workspaceId = null,
  className,
  size = "sm",
  labelOnHover = false,
}: {
  targetType: PinTargetType;
  targetId: string;
  workspaceId?: string | null;
  className?: string;
  size?: "sm" | "md";
  labelOnHover?: boolean;
}) {
  const utils = trpc.useUtils();

  // Read pins scoped to this workspace + target type. The narrow
  // query keeps the cache surface small — re-rendering one pin button
  // doesn't pull in every pin the user has across every workspace.
  const listInput = { workspaceId, targetType } as const;
  const { data: pins } = trpc.pin.listAll.useQuery(listInput);
  const pinned = (pins ?? []).some(
    (p) => p.targetType === targetType && p.targetId === targetId,
  );

  const toggle = trpc.pin.toggleEntity.useMutation({
    onMutate: async () => {
      await utils.pin.listAll.cancel(listInput);
      const prev = utils.pin.listAll.getData(listInput);
      // Optimistic remove is straightforward (we just drop it from the
      // list); optimistic add is harder because we'd need a hydrated
      // target row. Skip the optimistic add and let `onSuccess`
      // re-fetch — the visual still flips immediately because `pinned`
      // is derived from the cache value we just mutated.
      if (prev && pinned) {
        utils.pin.listAll.setData(
          listInput,
          prev.filter(
            (p) => !(p.targetType === targetType && p.targetId === targetId),
          ),
        );
      }
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) utils.pin.listAll.setData(listInput, ctx.prev);
      toast.error(err.message);
    },
    onSuccess: () => {
      void utils.pin.listAll.invalidate();
      // Legacy strip + sidebar cache — bump the no-arg list too so
      // anything keyed on the cross-workspace pin set refreshes.
      void utils.pin.list.invalidate();
      broadcastCrossTab({ type: "pins:updated" });
    },
  });

  const dim = size === "md" ? "h-7 w-7" : "h-6 w-6";
  const iconDim = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";
  const label = pinned ? "Unpin from sidebar" : "Pin to sidebar";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle.mutate({ workspaceId, targetType, targetId });
      }}
      title={label}
      aria-label={label}
      aria-pressed={pinned}
      className={cn(
        "focus-ring inline-flex items-center justify-center rounded-md hover:bg-subtle",
        dim,
        MOTION.fast,
        pinned ? "text-ember" : "text-muted-foreground hover:text-foreground",
        labelOnHover && "group/pin",
        className,
      )}
    >
      <PinIcon
        className={iconDim}
        fill={pinned ? "currentColor" : "none"}
        strokeWidth={pinned ? 1.5 : 2}
      />
      {labelOnHover && (
        <span className="text-meta ml-1 hidden group-hover/pin:inline">
          {pinned ? "Unpin" : "Pin"}
        </span>
      )}
    </button>
  );
}
