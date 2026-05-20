/**
 * Orthogonal A* edge routing for canvas connectors.
 *
 * Given two node rects and a set of obstacle rects, returns an SVG
 * `d` string that walks from the source-handle midpoint to the
 * target-handle midpoint along right-angle moves, smoothing each
 * corner with a short quadratic Bezier. Falls back to a straight
 * cubic Bezier when A* fails (graph too dense, no reachable path,
 * or the resulting walk exceeds the cell budget).
 *
 * The router is intentionally self-contained — no React, no Prisma,
 * no fetch — so a future test can run it on raw rect inputs.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HandleSide = "top" | "right" | "bottom" | "left";

export interface RouteRequest {
  from: { rect: Rect; handle: HandleSide };
  to: { rect: Rect; handle: HandleSide };
  /** Other nodes (NOT including from/to). */
  obstacles: Rect[];
  /** Padding around obstacles, in canvas units. */
  padding?: number;
  /** Grid cell size, in canvas units. */
  cellSize?: number;
}

export interface RoutedPath {
  /** SVG path "d" string. Cubic Bezier-smoothed corners. */
  d: string;
  /** Anchor points used (in canvas-space). */
  anchors: { x: number; y: number; side: HandleSide }[];
  /** True if A* succeeded; false if we fell back to straight cubic. */
  routed: boolean;
}

const DEFAULT_PADDING = 12;
const DEFAULT_CELL = 8;
const MAX_CELLS = 5_000;
const CORNER_RADIUS = 7;

interface CacheEntry {
  key: string;
  value: RoutedPath;
}

const routeCache = new Map<string, CacheEntry>();
const CACHE_CAP = 256;

function cacheGet(key: string): RoutedPath | undefined {
  const hit = routeCache.get(key);
  if (!hit) return undefined;
  // refresh LRU order
  routeCache.delete(key);
  routeCache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: RoutedPath): void {
  if (routeCache.has(key)) routeCache.delete(key);
  routeCache.set(key, { key, value });
  if (routeCache.size > CACHE_CAP) {
    const first = routeCache.keys().next().value;
    if (first !== undefined) routeCache.delete(first);
  }
}

/** Clear the module-local route cache (tests / debug). */
export function clearRouteCache(): void {
  routeCache.clear();
}

function handlePoint(rect: Rect, side: HandleSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 };
  }
}

function approachOffset(side: HandleSide, dist: number): { dx: number; dy: number } {
  switch (side) {
    case "top":
      return { dx: 0, dy: -dist };
    case "right":
      return { dx: dist, dy: 0 };
    case "bottom":
      return { dx: 0, dy: dist };
    case "left":
      return { dx: -dist, dy: 0 };
  }
}

/**
 * Build a coarse grid covering the bbox of (from, to, obstacles + padding)
 * plus a slack margin. Returns the world-space origin + dimensions.
 */
function buildGridFrame(
  fromRect: Rect,
  toRect: Rect,
  obstacles: Rect[],
  padding: number,
  cell: number,
): { ox: number; oy: number; cols: number; rows: number } {
  let minX = Math.min(fromRect.x, toRect.x);
  let minY = Math.min(fromRect.y, toRect.y);
  let maxX = Math.max(fromRect.x + fromRect.width, toRect.x + toRect.width);
  let maxY = Math.max(fromRect.y + fromRect.height, toRect.y + toRect.height);
  for (const o of obstacles) {
    minX = Math.min(minX, o.x);
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.width);
    maxY = Math.max(maxY, o.y + o.height);
  }
  const slack = Math.max(padding * 4, cell * 8);
  minX -= slack;
  minY -= slack;
  maxX += slack;
  maxY += slack;
  const cols = Math.max(2, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(2, Math.ceil((maxY - minY) / cell));
  return { ox: minX, oy: minY, cols, rows };
}

function fillObstacle(
  blocked: Uint8Array,
  frame: { ox: number; oy: number; cols: number; rows: number },
  cell: number,
  rect: Rect,
  padding: number,
): void {
  const x0 = rect.x - padding;
  const y0 = rect.y - padding;
  const x1 = rect.x + rect.width + padding;
  const y1 = rect.y + rect.height + padding;
  const c0 = Math.max(0, Math.floor((x0 - frame.ox) / cell));
  const r0 = Math.max(0, Math.floor((y0 - frame.oy) / cell));
  const c1 = Math.min(frame.cols - 1, Math.ceil((x1 - frame.ox) / cell));
  const r1 = Math.min(frame.rows - 1, Math.ceil((y1 - frame.oy) / cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      blocked[r * frame.cols + c] = 1;
    }
  }
}

function worldToCell(
  frame: { ox: number; oy: number; cols: number; rows: number },
  cell: number,
  x: number,
  y: number,
): { c: number; r: number } {
  const c = Math.max(0, Math.min(frame.cols - 1, Math.floor((x - frame.ox) / cell)));
  const r = Math.max(0, Math.min(frame.rows - 1, Math.floor((y - frame.oy) / cell)));
  return { c, r };
}

function cellToWorld(
  frame: { ox: number; oy: number; cols: number; rows: number },
  cell: number,
  c: number,
  r: number,
): { x: number; y: number } {
  return { x: frame.ox + c * cell + cell / 2, y: frame.oy + r * cell + cell / 2 };
}

interface AStarNode {
  c: number;
  r: number;
  g: number;
  f: number;
  parent: number;
  dir: number; // 0=N 1=E 2=S 3=W, -1=start
}

const DC = [0, 1, 0, -1];
const DR = [-1, 0, 1, 0];

/**
 * Orthogonal A* with a small turn-penalty so the path prefers
 * long straight runs over zigzags of equal Manhattan length.
 */
function aStar(
  blocked: Uint8Array,
  cols: number,
  rows: number,
  start: { c: number; r: number },
  goal: { c: number; r: number },
  budget: number,
): Array<{ c: number; r: number }> | null {
  const total = cols * rows;
  if (total === 0) return null;
  const startIdx = start.r * cols + start.c;
  const goalIdx = goal.r * cols + goal.c;

  const nodes: AStarNode[] = [];
  const idxToNode = new Int32Array(total);
  for (let i = 0; i < total; i++) idxToNode[i] = -1;

  const h0 = Math.abs(start.c - goal.c) + Math.abs(start.r - goal.r);
  nodes.push({ c: start.c, r: start.r, g: 0, f: h0, parent: -1, dir: -1 });
  idxToNode[startIdx] = 0;

  // Tiny binary heap over node ids ranked by f.
  const heap: number[] = [0];
  const heapPush = (nodeId: number) => {
    heap.push(nodeId);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nodes[heap[p]!]!.f <= nodes[heap[i]!]!.f) break;
      const tmp = heap[p]!;
      heap[p] = heap[i]!;
      heap[i] = tmp;
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const n = heap.length;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < n && nodes[heap[l]!]!.f < nodes[heap[best]!]!.f) best = l;
        if (r < n && nodes[heap[r]!]!.f < nodes[heap[best]!]!.f) best = r;
        if (best === i) break;
        const tmp = heap[best]!;
        heap[best] = heap[i]!;
        heap[i] = tmp;
        i = best;
      }
    }
    return top;
  };

  const closed = new Uint8Array(total);
  let visited = 0;

  while (heap.length > 0) {
    if (++visited > budget) return null;
    const currId = heapPop();
    const curr = nodes[currId]!;
    const cIdx = curr.r * cols + curr.c;
    if (closed[cIdx]) continue;
    closed[cIdx] = 1;

    if (cIdx === goalIdx) {
      const out: Array<{ c: number; r: number }> = [];
      let n: AStarNode | undefined = curr;
      while (n) {
        out.push({ c: n.c, r: n.r });
        n = n.parent === -1 ? undefined : nodes[n.parent];
      }
      out.reverse();
      return out;
    }

    for (let d = 0; d < 4; d++) {
      const nc = curr.c + DC[d]!;
      const nr = curr.r + DR[d]!;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nIdx = nr * cols + nc;
      if (blocked[nIdx]) continue;
      if (closed[nIdx]) continue;
      // step cost = 1 + turn penalty
      const turn = curr.dir !== -1 && curr.dir !== d ? 0.5 : 0;
      const g2 = curr.g + 1 + turn;
      const h2 = Math.abs(nc - goal.c) + Math.abs(nr - goal.r);
      const f2 = g2 + h2;
      const existingId = idxToNode[nIdx];
      if (existingId !== -1) {
        const ex = nodes[existingId]!;
        if (g2 >= ex.g) continue;
        ex.g = g2;
        ex.f = f2;
        ex.parent = currId;
        ex.dir = d;
        heapPush(existingId);
      } else {
        const id = nodes.length;
        nodes.push({ c: nc, r: nr, g: g2, f: f2, parent: currId, dir: d });
        idxToNode[nIdx] = id;
        heapPush(id);
      }
    }
  }
  return null;
}

/**
 * Reduce a sequence of cell coords to its turn corners (start, every
 * point where direction changes, end). Stable when input has only
 * one segment.
 */
function compressCorners(
  cells: Array<{ c: number; r: number }>,
): Array<{ c: number; r: number }> {
  if (cells.length <= 2) return cells.slice();
  const out: Array<{ c: number; r: number }> = [cells[0]!];
  for (let i = 1; i < cells.length - 1; i++) {
    const prev = cells[i - 1]!;
    const here = cells[i]!;
    const next = cells[i + 1]!;
    const d1c = here.c - prev.c;
    const d1r = here.r - prev.r;
    const d2c = next.c - here.c;
    const d2r = next.r - here.r;
    if (d1c !== d2c || d1r !== d2r) out.push(here);
  }
  out.push(cells[cells.length - 1]!);
  return out;
}

/**
 * Build an SVG path from corner points, replacing each interior
 * corner with a short quadratic Bezier for visual softness.
 */
function pathFromCorners(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const here = points[i]!;
    const next = points[i + 1]!;
    const inDx = here.x - prev.x;
    const inDy = here.y - prev.y;
    const outDx = next.x - here.x;
    const outDy = next.y - here.y;
    const inLen = Math.hypot(inDx, inDy) || 1;
    const outLen = Math.hypot(outDx, outDy) || 1;
    const r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
    const ax = here.x - (inDx / inLen) * r;
    const ay = here.y - (inDy / inLen) * r;
    const bx = here.x + (outDx / outLen) * r;
    const by = here.y + (outDy / outLen) * r;
    d += ` L ${ax} ${ay} Q ${here.x} ${here.y} ${bx} ${by}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function straightCubic(
  from: { x: number; y: number; side: HandleSide },
  to: { x: number; y: number; side: HandleSide },
): string {
  const dist = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) / 2);
  const a = approachOffset(from.side, dist);
  const b = approachOffset(to.side, dist);
  const c1x = from.x + a.dx;
  const c1y = from.y + a.dy;
  const c2x = to.x + b.dx;
  const c2y = to.y + b.dy;
  return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
}

function hashObstacles(obstacles: Rect[]): string {
  if (obstacles.length === 0) return "0";
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of obstacles) {
    if (o.x < minX) minX = o.x;
    if (o.y < minY) minY = o.y;
    if (o.x + o.width > maxX) maxX = o.x + o.width;
    if (o.y + o.height > maxY) maxY = o.y + o.height;
  }
  return `${obstacles.length}:${Math.round(minX)}:${Math.round(minY)}:${Math.round(maxX)}:${Math.round(maxY)}`;
}

function cacheKey(req: RouteRequest): string {
  const f = req.from.rect;
  const t = req.to.rect;
  return [
    Math.round(f.x),
    Math.round(f.y),
    Math.round(f.width),
    Math.round(f.height),
    req.from.handle,
    Math.round(t.x),
    Math.round(t.y),
    Math.round(t.width),
    Math.round(t.height),
    req.to.handle,
    hashObstacles(req.obstacles),
    req.padding ?? DEFAULT_PADDING,
    req.cellSize ?? DEFAULT_CELL,
  ].join("|");
}

export function routeEdge(req: RouteRequest): RoutedPath {
  const key = cacheKey(req);
  const cached = cacheGet(key);
  if (cached) return cached;

  const padding = req.padding ?? DEFAULT_PADDING;
  const cell = req.cellSize ?? DEFAULT_CELL;
  const fromPoint = handlePoint(req.from.rect, req.from.handle);
  const toPoint = handlePoint(req.to.rect, req.to.handle);
  const anchors = [
    { ...fromPoint, side: req.from.handle },
    { ...toPoint, side: req.to.handle },
  ];

  const frame = buildGridFrame(req.from.rect, req.to.rect, req.obstacles, padding, cell);
  const blocked = new Uint8Array(frame.cols * frame.rows);
  for (const o of req.obstacles) fillObstacle(blocked, frame, cell, o, padding);

  // Approach points step away from the handle so the path doesn't
  // graze the source/target node and so the start direction matches
  // the handle side.
  const approachDist = Math.max(cell * 2, padding);
  const startWorld = (() => {
    const off = approachOffset(req.from.handle, approachDist);
    return { x: fromPoint.x + off.dx, y: fromPoint.y + off.dy };
  })();
  const goalWorld = (() => {
    const off = approachOffset(req.to.handle, approachDist);
    return { x: toPoint.x + off.dx, y: toPoint.y + off.dy };
  })();
  const startCell = worldToCell(frame, cell, startWorld.x, startWorld.y);
  const goalCell = worldToCell(frame, cell, goalWorld.x, goalWorld.y);
  // Clear the cells under the source/target endpoints so A* can
  // enter/exit even if the obstacle rasterization rounded into them.
  blocked[startCell.r * frame.cols + startCell.c] = 0;
  blocked[goalCell.r * frame.cols + goalCell.c] = 0;

  const cells = aStar(blocked, frame.cols, frame.rows, startCell, goalCell, MAX_CELLS);
  if (!cells || cells.length === 0 || cells.length > MAX_CELLS) {
    const fallback: RoutedPath = {
      d: straightCubic(anchors[0]!, anchors[1]!),
      anchors,
      routed: false,
    };
    cacheSet(key, fallback);
    return fallback;
  }

  // Build world-space corner list: handle point → approach point →
  // every direction-change → goal approach → handle point.
  const corners = compressCorners(cells);
  const worldPoints: Array<{ x: number; y: number }> = [];
  worldPoints.push(fromPoint);
  // First A* corner is the start approach cell — use the corrected
  // approach world point so the first leg is axis-aligned with the
  // handle side rather than snapped to grid center.
  worldPoints.push(startWorld);
  for (let i = 1; i < corners.length - 1; i++) {
    const cellPt = corners[i]!;
    worldPoints.push(cellToWorld(frame, cell, cellPt.c, cellPt.r));
  }
  worldPoints.push(goalWorld);
  worldPoints.push(toPoint);

  // Coalesce co-linear runs (e.g. handle→approach→first-grid-corner
  // when they're already aligned) so the smoothing pass only fires
  // at real turns.
  const cleaned: Array<{ x: number; y: number }> = [worldPoints[0]!];
  for (let i = 1; i < worldPoints.length - 1; i++) {
    const prev = cleaned[cleaned.length - 1]!;
    const here = worldPoints[i]!;
    const next = worldPoints[i + 1]!;
    const a = { x: here.x - prev.x, y: here.y - prev.y };
    const b = { x: next.x - here.x, y: next.y - here.y };
    const cross = a.x * b.y - a.y * b.x;
    const dot = a.x * b.x + a.y * b.y;
    if (Math.abs(cross) < 0.5 && dot >= 0) continue;
    cleaned.push(here);
  }
  cleaned.push(worldPoints[worldPoints.length - 1]!);

  const result: RoutedPath = {
    d: pathFromCorners(cleaned),
    anchors,
    routed: true,
  };
  cacheSet(key, result);
  return result;
}
