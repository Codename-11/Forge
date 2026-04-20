import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Rich empty-state block for pages, sections, and cards.
 *
 * Three size variants:
 *  - `page` — large centered hero, used on empty pages (e.g. "No issues yet").
 *  - `section` — medium, fits inside a Card or Section.
 *  - `card` — compact, fits inside a small card or list header.
 *
 * All variants render warm muted-foreground text with an optional subtle
 * icon and optional CTA `action` slot. Pass `as="li"` to slot inside a
 * `<ul>` list card (see {@link Card}).
 */
export interface EmptyStateProps {
  /** Optional icon element (usually a Lucide icon). Sized per variant. */
  icon?: ReactNode;
  /** Primary heading line. */
  title: ReactNode;
  /** Optional supporting copy. Keep to a sentence or two. */
  description?: ReactNode;
  /** Optional CTA (e.g. a `<Button>` or keyboard hint row). */
  action?: ReactNode;
  /** Size variant. Defaults to `section`. */
  variant?: "page" | "section" | "card";
  /** Root element tag. Use `li` inside list cards. */
  as?: "li" | "div" | "section";
  className?: string;
}

const VARIANT: Record<
  NonNullable<EmptyStateProps["variant"]>,
  { wrap: string; icon: string; iconInner: string; title: string; desc: string; gap: string }
> = {
  page: {
    wrap: "px-6 py-20",
    icon: "h-14 w-14",
    iconInner: "h-6 w-6",
    title: "text-base font-medium",
    desc: "max-w-sm text-sm",
    gap: "gap-3",
  },
  section: {
    wrap: "px-6 py-12",
    icon: "h-10 w-10",
    iconInner: "h-4 w-4",
    title: "text-sm font-medium",
    desc: "max-w-xs text-xs",
    gap: "gap-2",
  },
  card: {
    wrap: "px-4 py-6",
    icon: "h-8 w-8",
    iconInner: "h-3.5 w-3.5",
    title: "text-sm",
    desc: "max-w-xs text-xs",
    gap: "gap-1.5",
  },
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "section",
  as: Tag = "div",
  className,
}: EmptyStateProps) {
  const v = VARIANT[variant];
  return (
    <Tag
      className={cn(
        "flex flex-col items-center justify-center text-center text-muted-foreground",
        v.wrap,
        v.gap,
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            "grid place-items-center rounded-full bg-subtle text-muted-foreground",
            v.icon,
          )}
          aria-hidden="true"
        >
          <span className={cn("grid place-items-center [&>svg]:h-full [&>svg]:w-full", v.iconInner)}>
            {icon}
          </span>
        </div>
      )}
      <div className={cn("text-foreground", v.title)}>{title}</div>
      {description && <p className={cn("text-muted-foreground", v.desc)}>{description}</p>}
      {action && <div className="mt-2 flex items-center justify-center gap-2">{action}</div>}
    </Tag>
  );
}
