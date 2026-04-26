"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { useModalBehavior } from "./use-modal-behavior";

/**
 * Small centered confirmation dialog. Use when the call-site needs an
 * unambiguous yes/no before proceeding — NOT for forms.
 *
 * Destructive variant supports `typeToConfirm`: the user must type the
 * exact string into an input before the primary button becomes active.
 * The Cancel button gets initial focus in that mode so the destructive
 * primary is never pre-focused.
 */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  primaryLabel,
  secondaryLabel = "Cancel",
  variant = "default",
  typeToConfirm,
  onConfirm,
  onCancel,
  loading = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  primaryLabel: string;
  secondaryLabel?: string;
  variant?: "default" | "destructive";
  /** Only honored when variant is "destructive". */
  typeToConfirm?: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  /** External loading state — overrides the internal pending flag. */
  loading?: boolean;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const confirmInputRef = React.useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = React.useState("");
  const [pending, setPending] = React.useState(false);

  const destructive = variant === "destructive";
  const gated = destructive && !!typeToConfirm;
  const matchesConfirm = !gated || typed === typeToConfirm;

  useModalBehavior({
    open,
    onClose: () => close(false),
    containerRef,
    // In destructive mode, start focus on the type-to-confirm input (if
    // present) or the Cancel button. Never on the destructive primary.
    initialFocusRef: gated ? confirmInputRef : destructive ? cancelRef : undefined,
  });

  React.useEffect(() => {
    if (!open) {
      setTyped("");
      setPending(false);
    }
  }, [open]);

  function close(success: boolean) {
    if (!success) onCancel?.();
    onOpenChange(false);
  }

  async function handleConfirm() {
    if (!matchesConfirm) return;
    if (pending || loading) return;
    try {
      setPending(true);
      await onConfirm();
    } finally {
      setPending(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await handleConfirm();
  }

  if (!open) return null;

  const isPending = pending || loading;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 pt-[18vh] backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={() => close(false)}
    >
      <div
        ref={containerRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={description ? "confirm-desc" : undefined}
        className={cn(
          "relative w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card shadow-xl",
          destructive && "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-ember/80",
          MOTION.slideUp,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="space-y-3 p-5">
          <div className="space-y-1.5">
            <h2
              id="confirm-title"
              className="text-sm font-semibold text-foreground"
            >
              {title}
            </h2>
            {description && (
              <p
                id="confirm-desc"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {description}
              </p>
            )}
          </div>

          {gated && (
            <div className="space-y-1.5">
              <label className="block text-[0.6875rem] text-muted-foreground">
                Type{" "}
                <span className="font-mono text-foreground">{typeToConfirm}</span>{" "}
                to confirm
              </label>
              <input
                ref={confirmInputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground placeholder:text-muted-foreground"
                placeholder={typeToConfirm}
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              ref={cancelRef}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => close(false)}
              disabled={isPending}
            >
              {secondaryLabel}
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={destructive ? "danger" : "ember"}
              disabled={!matchesConfirm || isPending}
            >
              {isPending && <Spinner size="sm" className="text-current" />}
              {primaryLabel}
              {matchesConfirm && !isPending && (
                <Kbd className="ml-1.5">⏎</Kbd>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
