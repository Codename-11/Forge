import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Card container.
 *
 * Variants:
 *  - `default` — solid card background with border.
 *  - `subtle` — translucent card tint (`bg-card/40`). Matches the look
 *    already used across settings pages.
 *  - `outlined` — just a border, no fill; use for nested cards.
 *
 * By default renders a `<div>`; pass `as="ul"` for list-style cards
 * (which also gain `divide-y` automatically).
 */
export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  variant?: "default" | "subtle" | "outlined";
  as?: "div" | "ul" | "section" | "article";
}

const CARD_VARIANT = {
  default: "border border-border bg-card",
  subtle: "border border-border bg-card/40",
  outlined: "border border-border bg-transparent",
} as const;

export const Card = React.forwardRef<HTMLElement, CardProps>(
  ({ className, variant = "subtle", as: Tag = "div", ...rest }, ref) => {
    const isList = Tag === "ul";
    return React.createElement(Tag, {
      ref,
      className: cn(
        "rounded-lg",
        CARD_VARIANT[variant],
        isList && "divide-y divide-border",
        className,
      ),
      ...rest,
    });
  },
);
Card.displayName = "Card";

/** Card header — top padding + divider below when followed by content. */
export function CardHeader({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-1 px-4 pt-4 pb-3", className)}
      {...rest}
    />
  );
}

/** Small semibold card title. Use inside `<CardHeader>`. */
export function CardTitle({
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-sm font-semibold text-foreground", className)}
      {...rest}
    />
  );
}

/** Muted description. Use inside `<CardHeader>` under the title. */
export function CardDescription({
  className,
  ...rest
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn("text-xs text-muted-foreground", className)}
      {...rest}
    />
  );
}

/** Card body content — standard padding. */
export function CardContent({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...rest} />;
}

/** Card footer — standard padding + top divider. */
export function CardFooter({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 border-t border-border px-4 py-3",
        className,
      )}
      {...rest}
    />
  );
}
