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
    const pad = 2;
    const plotWidth = Math.max(1, width - pad * 2);
    const plotHeight = Math.max(1, height - pad * 2);
    const stepX = (series: number[]) =>
      series.length > 1 ? plotWidth / (series.length - 1) : plotWidth;
    const toPath = (series: number[]) => {
      const points: string[] = [];
      const sx = stepX(series);
      for (let i = 0; i < series.length; i++) {
        const v = series[i]!;
        if (Number.isNaN(v)) continue;
        const x = pad + i * sx;
        const y = pad + plotHeight - (v / peak) * plotHeight;
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
      <line
        x1={2}
        x2={width - 2}
        y1={height - 2}
        y2={height - 2}
        stroke="hsl(var(--border))"
        strokeWidth={1}
      />
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
