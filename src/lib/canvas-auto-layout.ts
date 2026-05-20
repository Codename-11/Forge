/**
 * Pure-function layout engine for `CanvasFrame.autoLayout`.
 *
 * autoLayout JSON shape (loose — validated only at the edges):
 * ```
 * {
 *   direction: "horizontal" | "vertical",
 *   gap: number,
 *   paddingTop: number,
 *   paddingRight: number,
 *   paddingBottom: number,
 *   paddingLeft: number,
 *   align: "start" | "center" | "end",      // cross-axis
 *   justify: "start" | "center" | "end" | "space-between"
 * }
 * ```
 *
 * Children are placed inside the frame's padded inner box. Items keep
 * their own width/height; the layout decides position only. Stored
 * (x, y) on rows is ignored when the parent has autoLayout — the
 * render passes the computed positions through `displayNodes` /
 * `displayShapes` / `displayFrames` memos.
 *
 * Children are ordered by their stored (x, y) — primary axis first.
 * That makes drag-to-reorder feel right: when an operator drags an
 * item past a sibling, the next render places them in the new order.
 */

export type AutoLayoutSpec = {
  direction: "horizontal" | "vertical";
  gap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  align: "start" | "center" | "end";
  justify: "start" | "center" | "end" | "space-between";
};

export type AutoLayoutChild = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AutoLayoutFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DEFAULT_SPEC: AutoLayoutSpec = {
  direction: "vertical",
  gap: 12,
  paddingTop: 12,
  paddingRight: 12,
  paddingBottom: 12,
  paddingLeft: 12,
  align: "start",
  justify: "start",
};

/**
 * Defensive parse — accept the loose JSON shape (any subset) and fill
 * defaults for the missing fields. Returns null when the input doesn't
 * look like an auto-layout spec at all (so callers can skip).
 */
export function parseAutoLayout(raw: unknown): AutoLayoutSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const direction = r.direction === "horizontal" ? "horizontal" : r.direction === "vertical" ? "vertical" : null;
  // Some explicit signal that this is auto-layout. If `direction` is
  // missing AND no gap/padding/align/justify is set, treat as not-AL.
  const hasSignal =
    direction !== null ||
    typeof r.gap === "number" ||
    typeof r.paddingTop === "number" ||
    typeof r.paddingLeft === "number" ||
    typeof r.align === "string" ||
    typeof r.justify === "string";
  if (!hasSignal) return null;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    direction: direction ?? DEFAULT_SPEC.direction,
    gap: num(r.gap, DEFAULT_SPEC.gap),
    paddingTop: num(r.paddingTop, DEFAULT_SPEC.paddingTop),
    paddingRight: num(r.paddingRight, DEFAULT_SPEC.paddingRight),
    paddingBottom: num(r.paddingBottom, DEFAULT_SPEC.paddingBottom),
    paddingLeft: num(r.paddingLeft, DEFAULT_SPEC.paddingLeft),
    align:
      r.align === "center" || r.align === "end" || r.align === "start"
        ? r.align
        : DEFAULT_SPEC.align,
    justify:
      r.justify === "center" ||
      r.justify === "end" ||
      r.justify === "start" ||
      r.justify === "space-between"
        ? r.justify
        : DEFAULT_SPEC.justify,
  };
}

/**
 * Compute the (x, y) each child should render at. Returns a Map keyed
 * by child id with absolute canvas-space positions (not relative to
 * the frame). The caller decides which ids belong to this frame; this
 * function trusts its input.
 */
export function computeAutoLayout(
  frame: AutoLayoutFrame,
  spec: AutoLayoutSpec,
  children: AutoLayoutChild[],
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (children.length === 0) return out;

  // Sort by stored position along the primary axis so drag-to-reorder
  // reflects user intent on the next render.
  const ordered = [...children].sort((a, b) => {
    if (spec.direction === "horizontal") {
      if (a.x !== b.x) return a.x - b.x;
      return a.y - b.y;
    }
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  const innerLeft = frame.x + spec.paddingLeft;
  const innerTop = frame.y + spec.paddingTop;
  const innerRight = frame.x + frame.width - spec.paddingRight;
  const innerBottom = frame.y + frame.height - spec.paddingBottom;
  const innerWidth = Math.max(0, innerRight - innerLeft);
  const innerHeight = Math.max(0, innerBottom - innerTop);

  if (spec.direction === "horizontal") {
    const total = ordered.reduce((acc, c, i) => acc + c.width + (i > 0 ? spec.gap : 0), 0);
    let startX = innerLeft;
    let gap = spec.gap;
    if (spec.justify === "center") startX = innerLeft + (innerWidth - total) / 2;
    else if (spec.justify === "end") startX = innerRight - total;
    else if (spec.justify === "space-between" && ordered.length > 1) {
      const totalWidths = ordered.reduce((a, c) => a + c.width, 0);
      gap = (innerWidth - totalWidths) / (ordered.length - 1);
      startX = innerLeft;
    }
    let cursor = startX;
    for (const child of ordered) {
      let y = innerTop;
      if (spec.align === "center") y = innerTop + (innerHeight - child.height) / 2;
      else if (spec.align === "end") y = innerBottom - child.height;
      out.set(child.id, { x: cursor, y });
      cursor += child.width + gap;
    }
  } else {
    const total = ordered.reduce((acc, c, i) => acc + c.height + (i > 0 ? spec.gap : 0), 0);
    let startY = innerTop;
    let gap = spec.gap;
    if (spec.justify === "center") startY = innerTop + (innerHeight - total) / 2;
    else if (spec.justify === "end") startY = innerBottom - total;
    else if (spec.justify === "space-between" && ordered.length > 1) {
      const totalHeights = ordered.reduce((a, c) => a + c.height, 0);
      gap = (innerHeight - totalHeights) / (ordered.length - 1);
      startY = innerTop;
    }
    let cursor = startY;
    for (const child of ordered) {
      let x = innerLeft;
      if (spec.align === "center") x = innerLeft + (innerWidth - child.width) / 2;
      else if (spec.align === "end") x = innerRight - child.width;
      out.set(child.id, { x, y: cursor });
      cursor += child.height + gap;
    }
  }

  return out;
}
