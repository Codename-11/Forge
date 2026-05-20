import "server-only";
import { db } from "@/server/db";

/**
 * Build a compact text summary of a canvas for injection into the chat
 * agent's system prompt. Returns null when the canvas is missing or out of
 * the workspace — caller falls back to the canvas-free prompt.
 *
 * The summary is refreshed at every model turn (see chat-stream.ts loop)
 * so the agent sees state it just modified without round-tripping
 * `canvases.hydrate` itself.
 */
export async function loadCanvasContextSummary(
  workspaceId: string,
  canvasId: string,
): Promise<string | null> {
  const canvas = await db.workspaceCanvas.findFirst({
    where: { id: canvasId, workspaceId, archivedAt: null },
    include: {
      nodes: { select: { id: true, targetType: true, x: true, y: true, width: true, height: true } },
      shapes: { select: { id: true, kind: true, x: true, y: true, width: true, height: true } },
      _count: { select: { edges: true } },
    },
  });
  if (!canvas) return null;

  const countsByTargetType: Record<string, number> = {};
  for (const n of canvas.nodes) {
    countsByTargetType[n.targetType] = (countsByTargetType[n.targetType] ?? 0) + 1;
  }
  const countsByShapeKind: Record<string, number> = {};
  for (const s of canvas.shapes) {
    countsByShapeKind[s.kind] = (countsByShapeKind[s.kind] ?? 0) + 1;
  }

  // Bounding box across nodes and shapes — gives the agent a sense of
  // where existing content sits before it picks coordinates.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const accumulate = (
    x: number,
    y: number,
    w: number | null | undefined,
    h: number | null | undefined,
  ) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    const right = x + (w ?? 0);
    const bottom = y + (h ?? 0);
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  };
  for (const n of canvas.nodes) accumulate(n.x, n.y, n.width, n.height);
  for (const s of canvas.shapes) accumulate(s.x, s.y, s.width, s.height);
  const bbox =
    canvas.nodes.length + canvas.shapes.length > 0
      ? `(${Math.round(minX)},${Math.round(minY)}) to (${Math.round(maxX)},${Math.round(maxY)})`
      : "empty";

  const targetSummary = Object.entries(countsByTargetType)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ") || "none";
  const shapeSummary = Object.entries(countsByShapeKind)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ") || "none";

  return [
    `Canvas binding: "${canvas.name}" (id=${canvas.id}, scope=${canvas.scopeType ?? "workspace"}).`,
    `- ${canvas.nodes.length} nodes (${targetSummary})`,
    `- ${canvas.shapes.length} shapes (${shapeSummary})`,
    `- ${canvas._count.edges} edges`,
    `- Bounding box: ${bbox}`,
    `Tools available include canvases.* — use them to modify this canvas in place. Always confirm before writes.`,
  ].join("\n");
}
