import type { ReactNode } from "react";

/**
 * Settings section primitive. A heading row (small semibold title + optional
 * hint) followed by the body. Keep pages consistent — no ad-hoc <h2> or
 * muted-hint wrappers inline.
 */
export function Section({
  title,
  hint,
  actions,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div>{children}</div>
    </section>
  );
}
