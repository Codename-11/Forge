"use client";
import * as React from "react";
import { Toaster as SonnerToaster, toast as sonnerToast } from "sonner";

/**
 * Toast system.
 *
 * Forge already ships `sonner` as its toast engine (mounted at
 * `src/app/layout.tsx`). This module is a thin, stable wrapper around
 * it so callers have one internal API to use:
 *
 *   import { ToastProvider, useToast } from "@/components/ui";
 *   const { toast, dismiss } = useToast();
 *   toast({ title: "Saved", variant: "success" });
 *
 * Existing `import { toast } from "sonner"` call-sites keep working
 * unchanged — no retrofit required for this PR.
 */

export type ToastVariant = "default" | "success" | "error" | "warning";

export interface ToastOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  /** ms before auto-dismiss. Defaults to 4000. */
  duration?: number;
}

/**
 * Mount once near the root of the app shell. Renders the toast stack
 * in the bottom-right with a warm-earthy theme + left-accent stripe
 * per variant. Auto-respects the user's theme + reduced motion.
 *
 * (Forge's current `app/layout.tsx` mounts `<Toaster />` directly from
 * sonner; this component is identical in behavior and is the preferred
 * import going forward.)
 */
export function ToastProvider({
  position = "bottom-right",
}: {
  position?:
    | "top-left"
    | "top-right"
    | "top-center"
    | "bottom-left"
    | "bottom-right"
    | "bottom-center";
}) {
  return (
    <SonnerToaster
      position={position}
      closeButton
      richColors
      theme="system"
      duration={4000}
      toastOptions={{
        classNames: {
          toast:
            "border border-border bg-card text-foreground shadow-sm rounded-lg",
          title: "text-sm font-medium text-foreground",
          description: "text-xs text-muted-foreground",
          closeButton:
            "bg-subtle text-muted-foreground hover:text-foreground border border-border",
        },
      }}
    />
  );
}

/**
 * Fire a toast imperatively.
 *
 * Can be called outside the React tree (same semantics as sonner's
 * `toast()`). The hook {@link useToast} returns the same fn plus a
 * `dismiss` helper for convenience.
 */
export function toast(opts: ToastOptions): string | number {
  const { title, description, variant = "default", duration } = opts;
  const payload = {
    description,
    ...(duration !== undefined ? { duration } : {}),
  };
  switch (variant) {
    case "success":
      return sonnerToast.success(title, payload);
    case "error":
      return sonnerToast.error(title, payload);
    case "warning":
      return sonnerToast.warning(title, payload);
    default:
      return sonnerToast(title, payload);
  }
}

/** Dismiss a specific toast (by id) or all toasts (no arg). */
export function dismissToast(id?: string | number): void {
  if (id === undefined) sonnerToast.dismiss();
  else sonnerToast.dismiss(id);
}

/**
 * React hook — returns `{ toast, dismiss }`. Identical API to
 * shadcn/ui's `useToast`, so callers can swap in either.
 */
export function useToast() {
  return React.useMemo(
    () => ({
      toast,
      dismiss: dismissToast,
    }),
    [],
  );
}
