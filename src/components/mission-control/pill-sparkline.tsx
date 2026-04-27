"use client";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface PillSparklineProps {
  /** ISO timestamps + counts, oldest first. */
  points: { ts: string; count: number }[];
  /** Total minutes the sparkline represents (used to fill empty buckets). */
  windowMinutes: number;
  /** Bucket size in seconds — must match what the server returned. */
  bucketSeconds: number;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Tiny SVG line graph rendered inline in the pill. Reads as an "EKG":
 * recent activity on the right, history on the left.
 *
 * We backfill empty buckets to keep the x-axis honest — a lull shows as
 * a flat low line, not a compressed segment.
 */
export function PillSparkline({
  points,
  windowMinutes,
  bucketSeconds,
  width = 56,
  height = 14,
  className,
}: PillSparklineProps) {
  const path = useMemo(() => {
    const totalBuckets = Math.max(1, Math.ceil((windowMinutes * 60) / bucketSeconds));
    const now = Date.now();
    const earliest = now - windowMinutes * 60_000;
    const step = (windowMinutes * 60_000) / totalBuckets;
    const filled = new Array<number>(totalBuckets).fill(0);
    for (const p of points) {
      const t = new Date(p.ts).getTime();
      if (t < earliest) continue;
      const idx = Math.min(totalBuckets - 1, Math.floor((t - earliest) / step));
      filled[idx] += p.count;
    }
    const max = Math.max(1, ...filled);
    const dx = width / Math.max(1, totalBuckets - 1);
    const pts = filled.map((v, i) => {
      const x = i * dx;
      const y = height - (v / max) * (height - 1) - 0.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M${pts.join(" L")}`;
  }, [points, windowMinutes, bucketSeconds, width, height]);

  const hasActivity = points.some((p) => p.count > 0);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block", className)}
      aria-label="recent activity"
      role="img"
    >
      <path
        d={path}
        fill="none"
        stroke={hasActivity ? "currentColor" : "rgba(0,0,0,0.18)"}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-ember"
      />
    </svg>
  );
}
