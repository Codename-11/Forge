import type { ReactNode, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Backward-compat shim for the original settings Card.
 *
 * The canonical Card now lives at `@/components/ui/card` with variants
 * and header/content/footer slots. This shim keeps the legacy
 * `<Card>` that defaults to `<ul>` with `bg-card/40` + `divide-y`
 * alive for existing settings pages until Agent 4 retrofits them.
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
} & HTMLAttributes<HTMLElement>) {
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
