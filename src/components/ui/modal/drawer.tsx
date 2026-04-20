"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { useModalBehavior } from "./use-modal-behavior";

/**
 * <Drawer> — bottom sheet. Slides up from the bottom of the viewport.
 *
 * Intended for tablet widths and below as an alternative to `<SidePanel>`
 * when the side slide would be awkward. On desktop it's still usable
 * (e.g. for filters / option sheets) but the side-panel is usually the
 * right ergonomic at those widths.
 *
 * Keyboard: ⎋ closes. Click backdrop closes (unless `dismissOnBackdrop`
 * is false). Drag-to-dismiss is explicitly out of scope — we keep this
 * primitive dependency-free.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  dismissOnBackdrop = true,
  maxHeight = "70vh",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  dismissOnBackdrop?: boolean;
  /** Max visible height of the drawer. Default 70vh. */
  maxHeight?: string;
  children: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  useModalBehavior({
    open,
    onClose: () => onOpenChange(false),
    containerRef,
  });

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col justify-end bg-foreground/20 backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={() => dismissOnBackdrop && onOpenChange(false)}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "drawer-title" : undefined}
        aria-describedby={description ? "drawer-desc" : undefined}
        className={cn(
          "flex w-full flex-col rounded-t-xl border-t border-border bg-card shadow-xl",
          MOTION.slideInBottom,
        )}
        style={{ maxHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle affordance — purely visual; no drag wired up. */}
        <div className="flex justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-border" aria-hidden="true" />
        </div>

        {(title || description) && (
          <div className="space-y-0.5 px-5 pb-2 pt-3">
            {title && (
              <h2
                id="drawer-title"
                className="text-sm font-semibold text-foreground"
              >
                {title}
              </h2>
            )}
            {description && (
              <p
                id="drawer-desc"
                className="text-xs text-muted-foreground"
              >
                {description}
              </p>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">
          {children}
        </div>
      </div>
    </div>
  );
}
