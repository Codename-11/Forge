"use client";
import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useModalBehavior } from "./use-modal-behavior";

/**
 * Large centered modal for guided setup flows. Desktop gets a broad,
 * page-like panel; mobile becomes a full-screen sheet with the same header,
 * scroll region, and sticky footer.
 */
export function CenterModal({
  open,
  onOpenChange,
  title,
  description,
  size = "lg",
  footer,
  primaryLabel,
  secondaryLabel = "Cancel",
  onPrimary,
  onSecondary,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: "md" | "lg" | "xl";
  footer?: React.ReactNode;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => void | Promise<void>;
  onSecondary?: () => void;
  loading?: boolean;
  children: React.ReactNode;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = React.useState(false);

  useModalBehavior({
    open,
    onClose: () => onOpenChange(false),
    containerRef,
  });

  React.useEffect(() => {
    if (!open) setPending(false);
  }, [open]);

  async function handlePrimary() {
    if (!onPrimary || pending || loading) return;
    try {
      setPending(true);
      await onPrimary();
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;

  const maxWidth =
    size === "xl" ? "md:max-w-5xl" : size === "lg" ? "md:max-w-4xl" : "md:max-w-2xl";
  const isPending = pending || loading;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-stretch justify-center bg-foreground/20 backdrop-blur-sm md:items-center md:p-6",
        MOTION.fadeIn,
      )}
      onClick={() => onOpenChange(false)}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="center-modal-title"
        aria-describedby={description ? "center-modal-desc" : undefined}
        className={cn(
          "flex h-full w-full flex-col overflow-hidden border-border bg-card shadow-xl md:h-auto md:max-h-[88vh] md:rounded-lg md:border",
          maxWidth,
          MOTION.slideUp,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-1">
            <h2 id="center-modal-title" className="text-sm font-semibold text-foreground">
              {title}
            </h2>
            {description && (
              <p
                id="center-modal-desc"
                className="max-w-2xl text-xs leading-relaxed text-muted-foreground"
              >
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className={cn(
              "focus-ring shrink-0 rounded-md p-1 text-muted-foreground hover:bg-subtle hover:text-foreground",
              MOTION.fast,
            )}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {(footer || primaryLabel || onPrimary) && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card/80 px-5 py-3 backdrop-blur">
            {footer ?? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => {
                    onSecondary?.();
                    onOpenChange(false);
                  }}
                >
                  {secondaryLabel}
                </Button>
                {primaryLabel && (
                  <Button
                    type="button"
                    variant="ember"
                    size="sm"
                    onClick={handlePrimary}
                    disabled={isPending}
                  >
                    {isPending && <Spinner size="sm" className="text-current" />}
                    {primaryLabel}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
