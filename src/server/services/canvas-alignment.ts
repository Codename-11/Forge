/**
 * Pure functions for canvas align / distribute / tidy-up. Lives outside
 * the router so MCP can call the same compute path. Inputs are plain
 * `{ id, x, y, width, height, kind }` rectangles; output is a Map of
 * id → `{ x, y }` for the rows that should be updated. Items already
 * at the target position are still returned (caller can short-circuit
 * if it wants).
 *
 * Path / arrow shapes that lack a bounding box are skipped — the
 * router filters them before handing the list to these helpers.
 */

export type AlignKind = "node" | "shape" | "frame" | "group" | "instance";

export interface AlignItem {
  id: string;
  kind: AlignKind;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AlignOp =
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignTop"
  | "alignMiddle"
  | "alignBottom"
  | "distributeH"
  | "distributeV"
  | "tidyUp";

export type AlignPositions = Map<string, { x: number; y: number }>;

const TIDY_GRID = 8;

function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export function computeAlignment(items: AlignItem[], op: AlignOp): AlignPositions {
  const out: AlignPositions = new Map();
  if (items.length === 0) return out;

  if (
    op === "alignLeft" ||
    op === "alignCenter" ||
    op === "alignRight" ||
    op === "alignTop" ||
    op === "alignMiddle" ||
    op === "alignBottom"
  ) {
    if (items.length < 2) return out;
    const minLeft = Math.min(...items.map((i) => i.x));
    const maxRight = Math.max(...items.map((i) => i.x + i.width));
    const minTop = Math.min(...items.map((i) => i.y));
    const maxBottom = Math.max(...items.map((i) => i.y + i.height));
    const centerX = (minLeft + maxRight) / 2;
    const middleY = (minTop + maxBottom) / 2;
    for (const it of items) {
      let x = it.x;
      let y = it.y;
      switch (op) {
        case "alignLeft":
          x = minLeft;
          break;
        case "alignCenter":
          x = centerX - it.width / 2;
          break;
        case "alignRight":
          x = maxRight - it.width;
          break;
        case "alignTop":
          y = minTop;
          break;
        case "alignMiddle":
          y = middleY - it.height / 2;
          break;
        case "alignBottom":
          y = maxBottom - it.height;
          break;
      }
      out.set(it.id, { x, y });
    }
    return out;
  }

  if (op === "distributeH") {
    if (items.length < 3) return out;
    const sorted = [...items].sort((a, b) => a.x - b.x);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalSpan = last.x + last.width - first.x;
    const sumWidth = sorted.reduce((s, it) => s + it.width, 0);
    const gap = (totalSpan - sumWidth) / (sorted.length - 1);
    let cursor = first.x;
    for (const it of sorted) {
      out.set(it.id, { x: cursor, y: it.y });
      cursor += it.width + gap;
    }
    return out;
  }

  if (op === "distributeV") {
    if (items.length < 3) return out;
    const sorted = [...items].sort((a, b) => a.y - b.y);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalSpan = last.y + last.height - first.y;
    const sumHeight = sorted.reduce((s, it) => s + it.height, 0);
    const gap = (totalSpan - sumHeight) / (sorted.length - 1);
    let cursor = first.y;
    for (const it of sorted) {
      out.set(it.id, { x: it.x, y: cursor });
      cursor += it.height + gap;
    }
    return out;
  }

  if (op === "tidyUp") {
    for (const it of items) {
      out.set(it.id, { x: snap(it.x, TIDY_GRID), y: snap(it.y, TIDY_GRID) });
    }
    return out;
  }

  return out;
}
