import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Settings/page section primitive. A heading row (small semibold title
 * + optional muted hint + optional right-aligned actions) followed by
 * the body. Keeps spacing consistent across the app — prefer over
 * ad-hoc `<h2>` + `<p className="muted-foreground">` wrappers.
 */
export function Section({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const hasHeader = title || actions || hint;
  return (
    <section className={cn("space-y-2", className)}>
      {hasHeader && <SectionHeader title={title} hint={hint} actions={actions} />}
      <div>{children}</div>
    </section>
  );
}

/**
 * Standalone section header. Use inside custom layouts that need the
 * same title/hint/actions row shape without the `<Section>` wrapper.
 */
export function SectionHeader({
  title,
  hint,
  actions,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      {(title || actions) && (
        <div className="flex items-baseline justify-between gap-3">
          {title ? <h2 className="text-sm font-semibold">{title}</h2> : <span />}
          {actions}
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
