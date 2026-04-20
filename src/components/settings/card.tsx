import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Bordered list card used across settings list pages.
 * Wraps children in a <ul> with the standard divide/bg treatment.
 * Use inside a <Section> so the heading stays outside the card.
 */
export function Card({
  children,
  className,
  as: Tag = "ul",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "ul" | "div";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn(
        "divide-y divide-border rounded-lg border border-border bg-card/40",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
