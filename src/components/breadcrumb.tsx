"use client";
import Link from "next/link";
import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Generic breadcrumb trail. Last item renders as plain text (no link),
 * mid items render as low-contrast links that brighten on hover.
 *
 * Items can opt into mono rendering by setting `mono: true` — used for
 * issue keys (`AXI-42`) inside a breadcrumb. Defaults to sans for project
 * / cycle / initiative names. The whole row uses the `.text-meta` density
 * utility so the Appearance setting moves it.
 *
 * Designed to be slot-friendly: callers compose their own array of items;
 * Phase 1 will drop this into the topbar / detail-page headers.
 */
export type BreadcrumbItem = {
  label: string;
  href?: string;
  /** Render this segment in the mono identifier face (issue keys, etc). */
  mono?: boolean;
};

export function Breadcrumb({
  items,
  className,
  ariaLabel = "Breadcrumb",
}: {
  items: BreadcrumbItem[];
  className?: string;
  ariaLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "text-meta flex min-w-0 items-center text-muted-foreground",
        className,
      )}
    >
      <ol className="flex min-w-0 items-center gap-1.5">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          const segment = (
            <span
              className={cn(
                "min-w-0 truncate",
                item.mono && "font-mono",
                isLast ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {item.label}
            </span>
          );
          return (
            <Fragment key={`${i}-${item.label}`}>
              <li className="flex min-w-0 items-center">
                {item.href && !isLast ? (
                  <Link
                    href={item.href}
                    className="min-w-0 truncate transition-colors hover:text-foreground"
                  >
                    {segment}
                  </Link>
                ) : (
                  segment
                )}
              </li>
              {!isLast && (
                <li
                  aria-hidden
                  className="flex shrink-0 items-center text-muted-foreground/50"
                >
                  <ChevronRight className="h-3 w-3" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
