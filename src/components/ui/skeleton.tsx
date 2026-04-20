import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Generic shimmer placeholder block. Size via `className` (e.g.
 * `h-4 w-24`). Uses the `.ui-shimmer` class defined in globals.css,
 * which disables its animation when the user prefers reduced motion.
 */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("ui-shimmer rounded-md bg-subtle", className)}
      aria-hidden="true"
      {...rest}
    />
  );
}

/**
 * Multi-line text skeleton. Renders `lines` stacked Skeletons, the last
 * one slightly shorter for a natural ragged-edge feel.
 */
export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3", i === lines - 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

/**
 * Card-sized placeholder — header bar, two lines of body, optional
 * footer row. Drop-in while a `<Card>` fetches its data.
 */
export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border border-border bg-card/40 p-4",
        className,
      )}
      aria-hidden="true"
    >
      <Skeleton className="h-4 w-1/3" />
      <SkeletonText lines={2} />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-5 w-12 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
    </div>
  );
}

/**
 * Single-row skeleton — matches list-row height. Handy as a placeholder
 * inside an issue / project list while data is loading.
 */
export function SkeletonRow({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0",
        className,
      )}
      aria-hidden="true"
    >
      <Skeleton className="h-4 w-4 rounded-sm" />
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-3 flex-1" />
      <Skeleton className="h-5 w-14 rounded-full" />
      <Skeleton className="h-5 w-5 rounded-full" />
    </div>
  );
}

/**
 * List of `rows` SkeletonRow placeholders wrapped in a rounded border,
 * mirroring the shape of a Card-wrapped list.
 */
export function SkeletonList({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card/40",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}
