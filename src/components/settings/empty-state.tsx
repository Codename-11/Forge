import type { ComponentType, ReactNode } from "react";
import type { LucideProps } from "lucide-react";

/**
 * Shared empty-state for settings list pages. Renders as <li> by default so
 * it slots cleanly into the Card (which is a <ul>). Pass `as="div"` for
 * non-list contexts.
 *
 * Icon + title + optional hint. Keep it compact; this is not a hero.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  as: Tag = "li",
}: {
  icon?: ComponentType<LucideProps>;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  as?: "li" | "div";
}) {
  return (
    <Tag className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      {Icon && (
        <div className="grid h-9 w-9 place-items-center rounded-full bg-subtle text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
      )}
      <div className="text-sm text-foreground">{title}</div>
      {hint && <div className="max-w-xs text-xs text-muted-foreground">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </Tag>
  );
}
