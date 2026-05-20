"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Right-click context menu for the canvas (W3.3). Lives at the page
// level (NOT inside the scaling transform) so its width stays
// constant under zoom. Items come from the parent — we keep it
// dumb so background vs shape vs frame can be a one-line change at
// the call site.

export type ContextMenuItem =
  | { kind: "action"; label: string; shortcut?: string; danger?: boolean; onClick: () => void; disabled?: boolean }
  | { kind: "separator" };

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onDismiss: () => void;
};

export function CanvasContextMenu({ x, y, items, onDismiss }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onAway = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    // Defer registering so the click that opened the menu doesn't
    // immediately fire `onAway`.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", onAway);
      document.addEventListener("contextmenu", onAway);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("contextmenu", onAway);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute z-50 min-w-[200px] overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg"
      style={{ top: y, left: x }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.kind === "separator" ? (
          <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-border" />
        ) : (
          <button
            key={`a-${i}`}
            role="menuitem"
            type="button"
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick();
              onDismiss();
            }}
            className={cn(
              "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
              "text-foreground hover:bg-subtle",
              it.danger && "text-danger hover:text-danger",
              it.disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            <span>{it.label}</span>
            {it.shortcut && (
              <span className="ml-3 font-mono text-[0.625rem] text-muted-foreground">
                {it.shortcut}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );
}
