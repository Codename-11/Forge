"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";

/**
 * Minimal headless dialog — intentionally plain to avoid pulling in Radix.
 * Swap for Radix Dialog if/when project accepts the dep.
 */
export function Dialog({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[10vh] backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-xl",
          MOTION.slideUp,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
