"use client";
import { useMemo } from "react";
import Link from "next/link";
import { cn, formatIssueId } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Dependency DAG for the issue Relations tab — the focus issue's place in
 * its blocks/blocked-by chain and parent/child sub-issue tree.
 *
 * Layout is the same layered / longest-path topological sort the plan
 * `DagView` uses: a node's column = the longest directed path of
 * predecessors reaching it (roots at column 0), so blockers/parents fall
 * to the left, the focus issue sits mid-graph, and blocked work / children
 * flow right. Within a column, order by issue number for stability. Edges
 * are SVG cubic-beziers (source right → target left); `child` edges render
 * dashed to read distinctly from solid `blocks` edges. Any edge touching
 * the focus node gets the marching `.dag-edge-flow` ember treatment so
 * "you are here" and the live dependency path read at a glance.
 *
 * Self-contained, no graph library — mirrors the orchestration DagView so
 * the two dependency surfaces feel like one system.
 */

const NODE_W = 168;
const NODE_H = 52;
const COL_GAP = 60;
const ROW_GAP = 16;
const PAD = 12;

type GraphNode = {
  id: string;
  number: number;
  title: string;
  priority: string;
  statusCategory: string;
  statusColor: string;
  isCurrent: boolean;
};
type GraphEdge = { id: string; from: string; to: string; kind: "blocks" | "child" };

type Positioned = GraphNode & { x: number; y: number };

/** Longest-path layer for every node over the directed edge set. */
function computeLayers(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const preds = new Map<string, string[]>();
  for (const n of nodes) preds.set(n.id, []);
  for (const e of edges) {
    if (ids.has(e.from) && ids.has(e.to)) preds.get(e.to)!.push(e.from);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string, depth: number): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id) || depth > nodes.length + 1) {
      layer.set(id, 0);
      return 0;
    }
    const ps = preds.get(id) ?? [];
    if (ps.length === 0) {
      layer.set(id, 0);
      return 0;
    }
    visiting.add(id);
    let max = 0;
    for (const p of ps) max = Math.max(max, resolve(p, depth + 1) + 1);
    visiting.delete(id);
    layer.set(id, max);
    return max;
  };
  for (const n of nodes) resolve(n.id, 0);
  return layer;
}

const PRIORITY_TONE: Record<string, string> = {
  URGENT: "text-danger",
  HIGH: "text-warning",
};

export function IssueRelationsGraph({ issueId }: { issueId: string }) {
  const ws = useWorkspace();
  const { data, isLoading } = trpc.relation.graphForIssue.useQuery({ issueId });

  const layout = useMemo(() => {
    const nodes = (data?.nodes ?? []) as GraphNode[];
    const edges = (data?.edges ?? []) as GraphEdge[];
    if (nodes.length === 0) {
      return { positioned: [] as Positioned[], width: 0, height: 0, drawn: [] as Array<GraphEdge & { d: string; active: boolean }> };
    }
    const layerOf = computeLayers(nodes, edges);
    const byLayer = new Map<number, GraphNode[]>();
    for (const n of nodes) {
      const l = layerOf.get(n.id) ?? 0;
      const b = byLayer.get(l) ?? [];
      b.push(n);
      byLayer.set(l, b);
    }
    for (const b of byLayer.values()) b.sort((a, c) => a.number - c.number);

    const posById = new Map<string, Positioned>();
    const positioned: Positioned[] = [];
    let maxRows = 0;
    const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
    for (const l of layerKeys) {
      const bucket = byLayer.get(l)!;
      maxRows = Math.max(maxRows, bucket.length);
      bucket.forEach((n, row) => {
        const p: Positioned = {
          ...n,
          x: PAD + l * (NODE_W + COL_GAP),
          y: PAD + row * (NODE_H + ROW_GAP),
        };
        positioned.push(p);
        posById.set(n.id, p);
      });
    }
    const width = PAD * 2 + layerKeys.length * NODE_W + Math.max(0, layerKeys.length - 1) * COL_GAP;
    const height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP;

    const drawn = edges.flatMap((e) => {
      const s = posById.get(e.from);
      const t = posById.get(e.to);
      if (!s || !t) return [];
      const x1 = s.x + NODE_W;
      const y1 = s.y + NODE_H / 2;
      const x2 = t.x;
      const y2 = t.y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      const active = s.isCurrent || t.isCurrent;
      return [{ ...e, d, active }];
    });

    return { positioned, width, height, drawn };
  }, [data]);

  if (isLoading) {
    return <div className="px-3 py-6 text-center text-meta text-muted-foreground">Loading graph…</div>;
  }
  if (!data || data.nodes.length <= 1) {
    return (
      <div className="px-3 py-6 text-center text-meta text-muted-foreground">
        No linked issues to map yet. Add a blocker, sub-issue, or related link to
        see this issue&rsquo;s place in the dependency path.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-auto rounded-md border border-border bg-background/40">
        <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: "100%" }}>
          <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
            {layout.drawn.map((e) => (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeDasharray={e.kind === "child" ? "3 3" : undefined}
                className={cn(e.active ? "dag-edge-flow stroke-ember" : "stroke-border")}
              />
            ))}
          </svg>
          {layout.positioned.map((n) => (
            <div key={n.id} className="absolute" style={{ left: n.x, top: n.y }}>
              <GraphIssueNode node={n} slug={ws.slug} issueKey={formatIssueId(ws.key, n.number)} />
            </div>
          ))}
        </div>
      </div>
      <GraphLegend truncated={data.truncated} />
    </div>
  );
}

function GraphIssueNode({
  node,
  slug,
  issueKey,
}: {
  node: Positioned;
  slug: string;
  issueKey: string;
}) {
  const body = (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      title={node.title}
      className={cn(
        "group flex flex-col gap-1 rounded-md border bg-card/70 px-2 py-1.5 text-left transition-colors duration-150 ease-out",
        node.isCurrent
          ? "forge-active-node border-ember/60 bg-card ring-1 ring-ember/30"
          : "border-border hover:border-ember/50 hover:bg-card",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: node.statusColor }}
        />
        <span className="text-id text-muted-foreground">{issueKey}</span>
        {node.priority !== "NONE" && PRIORITY_TONE[node.priority] && (
          <span className={cn("ml-auto text-[0.5625rem] font-medium uppercase", PRIORITY_TONE[node.priority])}>
            {node.priority.toLowerCase()}
          </span>
        )}
        {node.isCurrent && (
          <span className="ml-auto rounded bg-ember/15 px-1 text-[0.5625rem] font-medium uppercase tracking-wider text-ember">
            here
          </span>
        )}
      </div>
      <span className="line-clamp-2 text-[0.75rem] leading-snug">{node.title}</span>
    </div>
  );

  if (node.isCurrent) return body;
  return (
    <Link href={`/w/${slug}/issues/${node.id}`} className="block focus-ring rounded-md">
      {body}
    </Link>
  );
}

function GraphLegend({ truncated }: { truncated: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[0.625rem] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line x1="0" y1="3" x2="18" y2="3" className="stroke-border" strokeWidth="1.5" />
        </svg>
        blocks →
      </span>
      <span className="inline-flex items-center gap-1">
        <svg width="18" height="6" aria-hidden>
          <line x1="0" y1="3" x2="18" y2="3" className="stroke-border" strokeWidth="1.5" strokeDasharray="3 3" />
        </svg>
        sub-issue →
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full bg-ember" /> this issue
      </span>
      {truncated && <span className="ml-auto italic">graph truncated</span>}
    </div>
  );
}
