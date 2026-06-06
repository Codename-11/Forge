"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { MOTION } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { useModalBehavior } from "./use-modal-behavior";
import { clearDraft, readDraft, saveDraft } from "./draft";

/**
 * <QuickForm> — centered small-form dialog for 1-3 field creates.
 *
 * Keyboard contract:
 *   ⏎         — submit primary
 *   ⌘⏎ / ⇧⏎   — submit secondary (if onSecondary provided)
 *   ⎋         — close (persists draft if `draftKey` + form is dirty)
 *
 * Draft persistence: when `draftKey` is provided, the form element's
 * values are scraped on close (via `FormData`) and stored under
 * `forge.draft.${draftKey}` for 24h. On next open, fields are re-hydrated
 * from the draft and a subtle "Restored draft" badge is shown.
 *
 * Error banner: if `onSubmit` throws OR returns `{ error: string }`,
 * the message is rendered as an inline warm-ember banner above fields.
 */
type SubmitResult = void | { error?: string | null } | undefined;

type QuickFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  primaryLabel: string;
  secondaryLabel?: string;
  onSubmit: (
    e: React.FormEvent<HTMLFormElement>,
  ) => SubmitResult | Promise<SubmitResult>;
  onSecondary?: () => void | Promise<void>;
  /** Optional external loading flag — merges with internal pending. */
  loading?: boolean;
  /**
   * When provided, form values are persisted to localStorage on close
   * (if dirty) and restored on reopen. Scoped under `forge.draft.${draftKey}`.
   */
  draftKey?: string;
  children: React.ReactNode;
  className?: string;
};

type DraftShape = Record<string, string>;

export function QuickForm({
  open,
  onOpenChange,
  title,
  description,
  primaryLabel,
  secondaryLabel,
  onSubmit,
  onSecondary,
  loading,
  draftKey,
  children,
  className,
}: QuickFormProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [restored, setRestored] = React.useState(false);

  useModalBehavior({
    open,
    onClose: () => handleClose(true),
    containerRef,
  });

  // Restore draft on open.
  React.useEffect(() => {
    if (!open || !draftKey) {
      setRestored(false);
      return;
    }
    const draft = readDraft<DraftShape>(draftKey);
    if (!draft) {
      setRestored(false);
      return;
    }
    // Defer until fields render.
    const raf = requestAnimationFrame(() => {
      const form = formRef.current;
      if (!form) return;
      for (const [name, value] of Object.entries(draft)) {
        const field = form.elements.namedItem(name) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | null;
        if (field && typeof value === "string") field.value = value;
      }
      setRestored(true);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, draftKey]);

  React.useEffect(() => {
    if (!open) {
      setPending(false);
      setError(null);
    }
  }, [open]);

  function currentFormValues(): DraftShape {
    const form = formRef.current;
    if (!form) return {};
    const fd = new FormData(form);
    const out: DraftShape = {};
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  }

  function isDirty(): boolean {
    return Object.keys(currentFormValues()).length > 0;
  }

  function handleClose(persistDraft: boolean) {
    if (draftKey) {
      if (persistDraft && isDirty()) {
        saveDraft(draftKey, currentFormValues());
      }
    }
    onOpenChange(false);
  }

  async function doSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending || loading) return;
    setError(null);
    setPending(true);
    try {
      const result = await onSubmit(e);
      if (result && typeof result === "object" && "error" in result && result.error) {
        setError(result.error);
        return;
      }
      // Success path — clear any stored draft.
      if (draftKey) clearDraft(draftKey);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  async function doSecondary() {
    if (!onSecondary) return;
    if (pending || loading) return;
    setError(null);
    setPending(true);
    try {
      await onSecondary();
      if (draftKey) clearDraft(draftKey);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter") return;
    const inTextarea = (e.target as HTMLElement)?.tagName === "TEXTAREA";
    // ⌘⏎ / Ctrl⏎ → secondary when defined, otherwise primary. Lets the
    // power-user "send" gesture work from inside any textarea field, not
    // just the single-line inputs that submit on plain Enter natively.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (onSecondary) {
        void doSecondary();
      } else if (formRef.current) {
        // Trigger the form's existing submit handler (which runs draft
        // clearing + close + the parent's onSubmit). requestSubmit is
        // preferred over .submit() because it dispatches a real submit
        // event the React handler is bound to.
        formRef.current.requestSubmit();
      }
      return;
    }
    // ⇧⏎ → secondary (mirrors keyboard-only "alt commit" affordance).
    if (e.shiftKey && onSecondary) {
      e.preventDefault();
      void doSecondary();
      return;
    }
    // Plain ⏎ in a textarea should still allow newlines — let the form's
    // native submit handle the non-textarea case.
    if (!e.metaKey && !e.ctrlKey && !e.shiftKey && inTextarea) {
      // default: insert newline
    }
  }

  if (!open) return null;

  const isPending = pending || loading;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/20 p-4 pt-12 backdrop-blur-sm",
        MOTION.fadeIn,
      )}
      onClick={() => handleClose(true)}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quickform-title"
        className={cn(
          "w-full max-w-md overflow-hidden rounded-lg border border-border bg-card shadow-xl",
          MOTION.slideUp,
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <form
          ref={formRef}
          onSubmit={doSubmit}
          onKeyDown={handleKeyDown}
          className="flex max-h-[calc(100dvh-5rem)] flex-col gap-3 p-5"
          noValidate
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2
                id="quickform-title"
                className="text-sm font-semibold text-foreground"
              >
                {title}
              </h2>
              {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
              )}
            </div>
            {restored && (
              <span className="shrink-0 rounded-md border border-ember/30 bg-ember/10 px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase tracking-wider text-ember">
                Restored draft
              </span>
            )}
          </div>

          {error && (
            <div className="rounded-md border border-ember/30 bg-ember/10 px-2.5 py-2 text-xs text-foreground">
              {error}
            </div>
          )}

          <div className="-mr-1 min-h-0 space-y-2.5 overflow-y-auto pr-1">{children}</div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleClose(true)}
              disabled={isPending}
            >
              Cancel
            </Button>
            {onSecondary && secondaryLabel && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={doSecondary}
                disabled={isPending}
              >
                {secondaryLabel}
                <Kbd className="ml-1.5">⌘⏎</Kbd>
              </Button>
            )}
            <Button type="submit" variant="ember" size="sm" disabled={isPending}>
              {isPending && <Spinner size="sm" className="text-current" />}
              {primaryLabel}
              {!isPending && <Kbd className="ml-1.5">⏎</Kbd>}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Labeled field wrapper for `<QuickForm>`. Renders a label with an optional
 * required star and an error-text slot below the control.
 */
function Field({
  label,
  required,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: React.ReactNode;
  required?: boolean;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <span>{label}</span>
          {required && <span className="text-ember">*</span>}
        </label>
      )}
      {children}
      {hint && !error && (
        <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>
      )}
      {error && (
        <p className="text-[0.6875rem] text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

QuickForm.Field = Field;
