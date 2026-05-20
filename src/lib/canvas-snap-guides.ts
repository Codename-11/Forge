// Smart alignment guides for the canvas drag layer.
//
// Pure functions — no React. The page passes in the moving item's
// bbox, the candidate sibling bboxes, and a snap threshold; we return
// a snapped bbox + the guide lines that should render this frame.
//
// Snap mechanics mirror Figma's behaviour: edges (left/center/right
// on X; top/middle/bottom on Y) attract when within
// `SNAP_THRESHOLD_PX` (post-zoom). Center alignment beats edges when
// both are in range. Snapping is independent per axis.

export type AABB = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SnapGuide = {
  /** Axis the guide is anchored on. */
  axis: "x" | "y";
  /** Canvas-space coordinate of the guide line. */
  at: number;
  /** Bounding span of the guide line so we can draw the minimum
   *  segment that visually connects the snapped pair instead of one
   *  that traverses the whole canvas. */
  spanStart: number;
  spanEnd: number;
  /** The sibling id that produced the snap (for debugging / tests). */
  siblingId: string;
};

export type DistanceLabel = {
  /** Mid-point of the labelled gap, in canvas space. */
  x: number;
  y: number;
  /** Distance value in canvas-space pixels. */
  value: number;
  /** Orientation drives the label rotation in the renderer. */
  axis: "x" | "y";
};

export type SnapResult = {
  /** Resulting bbox after snap, in canvas space. */
  bbox: AABB;
  /** Live guides to render this frame. */
  guides: SnapGuide[];
  /** Distance labels for the nearest sibling on each axis. */
  labels: DistanceLabel[];
  /** Width × Height label for the active bbox. */
  sizeLabel: { x: number; y: number; width: number; height: number };
};

export const SNAP_THRESHOLD_PX = 4;

type EdgeCandidate = {
  axis: "x" | "y";
  /** The active-bbox edge that would shift to align. */
  activeEdgeKey: "min" | "mid" | "max";
  /** The sibling-bbox edge being targeted. */
  siblingValue: number;
  /** Sibling whose edge produced this candidate. */
  sibling: AABB & { id: string };
};

const edgeValuesX = (b: AABB) => ({
  min: b.x,
  mid: b.x + b.width / 2,
  max: b.x + b.width,
});

const edgeValuesY = (b: AABB) => ({
  min: b.y,
  mid: b.y + b.height / 2,
  max: b.y + b.height,
});

/**
 * Snap an active bbox to nearby siblings.
 *
 * @param active   The active item's bbox (current drag position).
 * @param siblings Candidate sibling bboxes (typically same-parent
 *                 frame; pass empty array to disable snapping).
 * @param zoom     Viewport zoom — threshold is divided so the snap
 *                 distance stays constant in pixel terms.
 */
export function computeSnap(
  active: AABB,
  siblings: ReadonlyArray<AABB & { id: string }>,
  zoom: number,
): SnapResult {
  if (siblings.length === 0) {
    return {
      bbox: active,
      guides: [],
      labels: [],
      sizeLabel: { x: active.x, y: active.y, width: active.width, height: active.height },
    };
  }
  const threshold = SNAP_THRESHOLD_PX / Math.max(0.01, zoom);
  const activeX = edgeValuesX(active);
  const activeY = edgeValuesY(active);

  let bestX: { snap: number; cand: EdgeCandidate; delta: number } | null = null;
  let bestY: { snap: number; cand: EdgeCandidate; delta: number } | null = null;

  for (const s of siblings) {
    const sX = edgeValuesX(s);
    const sY = edgeValuesY(s);
    for (const ae of ["min", "mid", "max"] as const) {
      for (const se of ["min", "mid", "max"] as const) {
        // X axis.
        const dx = sX[se] - activeX[ae];
        if (Math.abs(dx) <= threshold) {
          const cand: EdgeCandidate = {
            axis: "x",
            activeEdgeKey: ae,
            siblingValue: sX[se],
            sibling: s,
          };
          // Center alignment wins ties.
          const score = ae === "mid" || se === "mid" ? Math.abs(dx) - 0.5 : Math.abs(dx);
          if (!bestX || score < Math.abs(bestX.delta)) bestX = { snap: dx, cand, delta: dx };
        }
        // Y axis.
        const dy = sY[se] - activeY[ae];
        if (Math.abs(dy) <= threshold) {
          const cand: EdgeCandidate = {
            axis: "y",
            activeEdgeKey: ae,
            siblingValue: sY[se],
            sibling: s,
          };
          const score = ae === "mid" || se === "mid" ? Math.abs(dy) - 0.5 : Math.abs(dy);
          if (!bestY || score < Math.abs(bestY.delta)) bestY = { snap: dy, cand, delta: dy };
        }
      }
    }
  }

  const snapped: AABB = {
    x: bestX ? active.x + bestX.snap : active.x,
    y: bestY ? active.y + bestY.snap : active.y,
    width: active.width,
    height: active.height,
  };

  const guides: SnapGuide[] = [];
  if (bestX) {
    const sib = bestX.cand.sibling;
    guides.push({
      axis: "x",
      at: bestX.cand.siblingValue,
      spanStart: Math.min(sib.y, snapped.y) - 8,
      spanEnd: Math.max(sib.y + sib.height, snapped.y + snapped.height) + 8,
      siblingId: sib.id,
    });
  }
  if (bestY) {
    const sib = bestY.cand.sibling;
    guides.push({
      axis: "y",
      at: bestY.cand.siblingValue,
      spanStart: Math.min(sib.x, snapped.x) - 8,
      spanEnd: Math.max(sib.x + sib.width, snapped.x + snapped.width) + 8,
      siblingId: sib.id,
    });
  }

  // Distance labels: for each axis, find the nearest sibling that
  // doesn't overlap on that axis and show the gap distance.
  const labels: DistanceLabel[] = [];
  const nearestOnAxis = (axis: "x" | "y"): { sibling: AABB; gap: number } | null => {
    let bestGap = Infinity;
    let best: AABB | null = null;
    for (const s of siblings) {
      if (axis === "x") {
        // Horizontal gap: only meaningful if vertical spans overlap.
        const vOverlap = !(s.y + s.height < snapped.y || s.y > snapped.y + snapped.height);
        if (!vOverlap) continue;
        const gap =
          s.x > snapped.x + snapped.width
            ? s.x - (snapped.x + snapped.width)
            : snapped.x > s.x + s.width
            ? snapped.x - (s.x + s.width)
            : Infinity;
        if (gap < bestGap) {
          bestGap = gap;
          best = s;
        }
      } else {
        const hOverlap = !(s.x + s.width < snapped.x || s.x > snapped.x + snapped.width);
        if (!hOverlap) continue;
        const gap =
          s.y > snapped.y + snapped.height
            ? s.y - (snapped.y + snapped.height)
            : snapped.y > s.y + s.height
            ? snapped.y - (s.y + s.height)
            : Infinity;
        if (gap < bestGap) {
          bestGap = gap;
          best = s;
        }
      }
    }
    return best && Number.isFinite(bestGap) ? { sibling: best, gap: bestGap } : null;
  };
  const nx = nearestOnAxis("x");
  if (nx) {
    const sib = nx.sibling;
    const isRight = sib.x > snapped.x + snapped.width;
    const labelX = isRight
      ? snapped.x + snapped.width + nx.gap / 2
      : sib.x + sib.width + nx.gap / 2;
    const labelY = snapped.y + snapped.height / 2;
    labels.push({ x: labelX, y: labelY, value: nx.gap, axis: "x" });
  }
  const ny = nearestOnAxis("y");
  if (ny) {
    const sib = ny.sibling;
    const isBelow = sib.y > snapped.y + snapped.height;
    const labelX = snapped.x + snapped.width / 2;
    const labelY = isBelow
      ? snapped.y + snapped.height + ny.gap / 2
      : sib.y + sib.height + ny.gap / 2;
    labels.push({ x: labelX, y: labelY, value: ny.gap, axis: "y" });
  }

  return {
    bbox: snapped,
    guides,
    labels,
    sizeLabel: {
      x: snapped.x + snapped.width / 2,
      y: snapped.y - 14,
      width: snapped.width,
      height: snapped.height,
    },
  };
}
