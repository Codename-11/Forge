"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useModalBehavior } from "./use-modal-behavior";

/**
 * <SidePanel> — slides in from the right edge. Use for heavy forms where
 * the page context behind should stay visible (edit cycle, relation
 * picker, attachment panel, etc.).
 *
 * Below the `md` breakpoint the side slide is replaced by a full-screen
 * overlay that stacks like a page — the mobile ergonomic is "a page
 * that appears", not "a sliver that slides in".
 *
 * Header + scrollable content + sticky footer. Default footer shows
 * Cancel + primary; pass `footer` to override.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  size = "default",
  primaryLabel,
  onPrimary,
  secondaryLabel = "Cancel",
  onSecondary,
  loading,
  dismissOnBackdrop = true,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: "default" | "wide";
  primaryLabel?: string;
  onPrimary?: () => void | Promise<void>;
  secondaryLabel?: string;
  onSecondary?: () => void;
  loading?: boolean;
  dismissOnBackdrop?: boolean;
  footer?: React.ReactNode;
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
    if (!onPrimary) return;
    if (pending || loading) return;
    try {
      setPending(true);
      await onPrimary();
    } finally {
      setPending(false);
    }
  }

  if (!open) return null;

  const width =
    size === "wide"
      ? "md:w-[560px]"
      : "md:w-[420px]";

  const isPending = pending || loading;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-end bg-foreground/20 backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={() => dismissOnBackdrop && onOpenChange(false)}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidepanel-title"
        aria-describedby={description ? "sidepanel-desc" : undefined}
        className={cn(
          // Mobile: full-screen overlay page. Desktop: right-edge side slide.
          "flex h-full w-full flex-col border-l border-border bg-card shadow-xl",
          width,
          "md:max-w-full",
          // Motion: slide from right on md+, fade from bottom-like on mobile.
          "motion-safe:animate-in motion-safe:fade-in duration-150 ease-out",
          "md:motion-safe:slide-in-from-right-4",
          "motion-safe:slide-in-from-bottom-4",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-0.5">
            <h2
              id="sidepanel-title"
              className="truncate text-sm font-semibold text-foreground"
            >
              {title}
            </h2>
            {description && (
              <p
                id="sidepanel-desc"
                className="text-xs leading-relaxed text-muted-foreground"
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
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>

        {/* Sticky footer */}
        {(footer || primaryLabel || onPrimary) && (
          <div className="flex items-center justify-end gap-2 border-t border-border bg-card/80 px-5 py-3 backdrop-blur">
            {footer ?? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onSecondary?.();
                    onOpenChange(false);
                  }}
                  disabled={isPending}
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
