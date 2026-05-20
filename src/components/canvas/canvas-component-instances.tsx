"use client";

import { memo, type MouseEvent } from "react";
import { Package } from "lucide-react";

type InstanceRow = {
  id: string;
  componentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hiddenAt?: Date | string | null;
  lockedAt?: Date | string | null;
};

/**
 * Placeholder renderer for `CanvasComponentInstance` rows. v1 doesn't
 * expand the component's definition into raw nodes on the canvas (that's
 * the `instanceDetach` server proc); each instance shows as a stylized
 * bordered card with the component name in the center so the operator
 * sees where instances are placed without yet rendering their interior.
 */
export const CanvasComponentInstances = memo(function CanvasComponentInstances({
  instances,
  componentNameById,
  selectedIds,
  onSelect,
}: {
  instances: InstanceRow[];
  componentNameById: Map<string, string>;
  selectedIds: Set<string>;
  onSelect: (id: string, e: MouseEvent) => void;
}) {
  if (instances.length === 0) return null;
  return (
    <>
      {instances.map((inst) => {
        if (inst.hiddenAt) return null;
        const name = componentNameById.get(inst.componentId) ?? "Component";
        const selected = selectedIds.has(inst.id);
        return (
          <div
            key={inst.id}
            data-canvas-instance
            data-instance-id={inst.id}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              onSelect(inst.id, e);
            }}
            className={[
              "absolute flex flex-col items-center justify-center gap-1 rounded-md border border-dashed",
              "bg-card/40 text-foreground/80 shadow-sm transition-colors",
              "hover:bg-card/60 hover:text-foreground hover:border-foreground/40",
              selected ? "border-ember/80 ring-1 ring-ember/40" : "border-border",
              inst.lockedAt ? "opacity-80" : "",
            ].join(" ")}
            style={{ left: inst.x, top: inst.y, width: inst.width, height: inst.height }}
          >
            <Package className="h-4 w-4 text-muted-foreground" aria-hidden />
            <div className="text-meta uppercase tracking-wide text-muted-foreground">component</div>
            <div className="text-sm font-medium line-clamp-2 px-2 text-center">{name}</div>
          </div>
        );
      })}
    </>
  );
});
