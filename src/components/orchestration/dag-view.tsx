"use client";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { StepNode, STEP_NODE_WIDTH, STEP_NODE_HEIGHT } from "./step-node";
import { isStepActive, type DagAgent, type DagStep } from "./types";

/**
 * DAG visualization for an ExecutionPlan's steps.
 *
 * Layout — layered / longest-path topological:
 *   1. Compute each step's layer = longest dependency chain from a root
 *      (a step with no deps is layer 0; a step's layer is
 *      max(dep.layer) + 1). This is the standard "rank by longest path"
 *      used by Graphviz/dagre for left-to-right pipelines and gives a
 *      stable column for every node even when the graph branches.
 *   2. Place layers as columns (x), order nodes within a column by their
 *      `position` (y) so the visual order matches the plan's authored
 *      order. Cycles (shouldn't happen, but defensively) are broken by
 *      capping iterations — any step that can't resolve lands in the
 *      last computed layer.
 *
 * Edges are SVG cubic-bezier curves from the right edge of a dependency
 * to the left edge of its dependent. Edges touching a RUNNING node get
 * the marching-dash `.dag-edge-flow` class (defined in globals.css,
 * reduced-motion aware) so the live execution path is obvious.
 *
 * Self-contained: no graph library, ~150 lines. Horizontally scrollable
 * when the graph is wider than the panel.
 */

const COL_GAP = 56;
const ROW_GAP = 18;
const PAD = 16;

type Positioned = DagStep & { layer: number; x: number; y: number };

function computeLayers(steps: DagStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  const resolve = (id: string, depth: number): number => {
    if (layer.has(id)) return layer.get(id) as number;
    // cycle / runaway guard
    if (visiting.has(id) || depth > steps.length + 1) {
      layer.set(id, 0);
      return 0;
    }
    const step = byId.get(id);
    if (!step) return 0;
    const deps = step.dependsOnStepIds.filter((d) => byId.has(d));
    if (deps.length === 0) {
      layer.set(id, 0);
      return 0;
    }
    visiting.add(id);
    let max = 0;
    for (const d of deps) max = Math.max(max, resolve(d, depth + 1) + 1);
    visiting.delete(id);
    layer.set(id, max);
    return max;
  };

  for (const s of steps) resolve(s.id, 0);
  return layer;
}

export function DagView({
  steps,
  agentsById,
  planHref,
  onSelectStep,
  className,
}: {
  steps: DagStep[];
  agentsById?: Record<string, DagAgent>;
  /** base href for the plan detail page; step id appended as hash */
  planHref?: string;
  onSelectStep?: (stepId: string) => void;
  className?: string;
}) {
  const { nodes, width, height, edges } = useMemo(() => {
    if (steps.length === 0) {
      return { nodes: [] as Positioned[], width: 0, height: 0, edges: [] as {
        id: string;
        d: string;
        active: boolean;
      }[] };
    }
    const layerOf = computeLayers(steps);

    // Group by layer, order within layer by position.
    const layers = new Map<number, DagStep[]>();
    for (const s of steps) {
      const l = layerOf.get(s.id) ?? 0;
      const bucket = layers.get(l) ?? [];
      bucket.push(s);
      layers.set(l, bucket);
    }
    for (const bucket of layers.values()) {
      bucket.sort((a, b) => a.position - b.position);
    }

    const positioned: Positioned[] = [];
    const posById = new Map<string, Positioned>();
    let maxRows = 0;
    const layerKeys = [...layers.keys()].sort((a, b) => a - b);
    for (const l of layerKeys) {
      const bucket = layers.get(l) as DagStep[];
      maxRows = Math.max(maxRows, bucket.length);
      bucket.forEach((s, row) => {
        const node: Positioned = {
          ...s,
          layer: l,
          x: PAD + l * (STEP_NODE_WIDTH + COL_GAP),
          y: PAD + row * (STEP_NODE_HEIGHT + ROW_GAP),
        };
        positioned.push(node);
        posById.set(s.id, node);
      });
    }

    const w =
      PAD * 2 +
      (layerKeys.length || 1) * STEP_NODE_WIDTH +
      Math.max(0, (layerKeys.length || 1) - 1) * COL_GAP;
    const h =
      PAD * 2 +
      maxRows * STEP_NODE_HEIGHT +
      Math.max(0, maxRows - 1) * ROW_GAP;

    // Edges: dep (source, right edge) → dependent (target, left edge).
    const edgeList: { id: string; d: string; active: boolean }[] = [];
    for (const node of positioned) {
      for (const depId of node.dependsOnStepIds) {
        const src = posById.get(depId);
        if (!src) continue;
        const x1 = src.x + STEP_NODE_WIDTH;
        const y1 = src.y + STEP_NODE_HEIGHT / 2;
        const x2 = node.x;
        const y2 = node.y + STEP_NODE_HEIGHT / 2;
        const mx = (x1 + x2) / 2;
        const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
        const active = isStepActive(src.status) || isStepActive(node.status);
        edgeList.push({ id: `${depId}->${node.id}`, d, active });
      }
    }

    return { nodes: positioned, width: w, height: h, edges: edgeList };
  }, [steps]);

  if (steps.length === 0) {
    return (
      <div className={cn("px-3 py-6 text-center text-meta text-muted-foreground", className)}>
        This plan has no steps yet.
      </div>
    );
  }

  return (
    <div className={cn("overflow-auto", className)}>
      <div className="relative" style={{ width, height, minWidth: "100%" }}>
        {/* Edge layer */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
          aria-hidden
        >
          {edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              fill="none"
              strokeWidth={1.5}
              className={cn(
                e.active
                  ? "dag-edge-flow stroke-ember"
                  : "stroke-border",
              )}
              strokeLinecap="round"
            />
          ))}
        </svg>

        {/* Node layer */}
        {nodes.map((n) => {
          const agent = n.assignedAgentId
            ? agentsById?.[n.assignedAgentId]
            : null;
          return (
            <div
              key={n.id}
              className="absolute"
              style={{ left: n.x, top: n.y }}
            >
              <StepNode
                step={n}
                agent={agent}
                active={isStepActive(n.status)}
                href={planHref ? `${planHref}#step-${n.id}` : undefined}
                onSelect={onSelectStep ? () => onSelectStep(n.id) : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
