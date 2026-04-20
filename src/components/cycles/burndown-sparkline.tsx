"use client";
import { useMemo } from "react";

/**
 * Tiny inline-SVG sparkline. Renders actual vs ideal burndown for a cycle.
 * No chart library — keeps the bundle lean and lets us use design tokens
 * directly via CSS vars.
 */
export function BurndownSparkline({
  actual,
  ideal,
  width = 120,
  height = 32,
}: {
  actual: number[];
  ideal: number[];
  width?: number;
  height?: number;
}) {
  const { actualPath, idealPath, max } = useMemo(() => {
    const pts = [...actual.filter((v) => !Number.isNaN(v)), ...ideal];
    const peak = Math.max(1, ...pts);
    const stepX = (series: number[]) =>
      series.length > 1 ? width / (series.length - 1) : width;
    const toPath = (series: number[]) => {
      const points: string[] = [];
      const sx = stepX(series);
      for (let i = 0; i < series.length; i++) {
        const v = series[i]!;
        if (Number.isNaN(v)) continue;
        const x = i * sx;
        const y = height - (v / peak) * height;
        points.push(`${points.length === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      return points.join(" ");
    };
    return {
      actualPath: toPath(actual),
      idealPath: toPath(ideal),
      max: peak,
    };
  }, [actual, ideal, width, height]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="shrink-0"
      role="img"
      aria-label={`Burndown: peak ${max} issues`}
    >
      {idealPath && (
        <path
          d={idealPath}
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth={1}
          strokeDasharray="2 2"
          opacity={0.6}
        />
      )}
      {actualPath && (
        <path
          d={actualPath}
          fill="none"
          stroke="hsl(var(--ember))"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
