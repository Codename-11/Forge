"use client";
import { useEffect, useMemo } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { broadcastCrossTab } from "@/hooks/use-realtime";
import { MOTION } from "@/lib/motion";

/**
 * Pin/unpin button for an issue — rendered in the issue detail topbar.
 *
 * Reads `pin.list()` (cross-workspace) and checks whether this issueId
 * is present. Optimistically toggles on click and mirrors the state in
 * the tRPC cache so the header strip + star fill update without a
 * round-trip. The `p` keyboard shortcut (registered in this component
 * via a lightweight effect so it only binds on issue detail) hits the
 * same toggle mutation.
 */
export function PinToggleButton({ issueId }: { issueId: string }) {
  const utils = trpc.useUtils();
  const { data: pins } = trpc.pin.list.useQuery();
  const pinned = useMemo(
    () => (pins ?? []).some((p) => p.id === issueId),
    [pins, issueId],
  );

  const toggle = trpc.pin.toggle.useMutation({
    onMutate: async () => {
      await utils.pin.list.cancel();
      const prev = utils.pin.list.getData();
      // We don't have full issue rows for an optimistic insert; fall
      // back to removing immediately or deferring the insert until the
      // server response comes back. Pins that are already present get
      // removed optimistically for instant feedback.
      if (prev && prev.some((p) => p.id === issueId)) {
        utils.pin.list.setData(undefined, prev.filter((p) => p.id !== issueId));
      }
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) utils.pin.list.setData(undefined, ctx.prev);
      toast.error(err.message);
    },
    onSuccess: () => {
      utils.pin.list.invalidate();
      // Tell every other tab to refresh their pins strip — pins are
      // user-scoped and the SSE stream is per-workspace.
      broadcastCrossTab({ type: "pins:updated" });
    },
  });

  // Bind `p` to pin/unpin when a textarea/input isn't focused.
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        toggle.mutate({ issueId });
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [issueId, toggle]);

  return (
    <button
      type="button"
      onClick={() => toggle.mutate({ issueId })}
      className={cn(
        "focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-subtle",
        MOTION.fast,
        pinned ? "text-ember" : "text-muted-foreground",
      )}
      title={pinned ? "Unpin (p)" : "Pin (p)"}
    >
      <Star
        className="h-4 w-4"
        fill={pinned ? "currentColor" : "none"}
        strokeWidth={pinned ? 1.5 : 2}
      />
    </button>
  );
}
