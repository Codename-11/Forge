import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Small monospace pill for rendering a single key or key-symbol.
 * Use inside prose or empty-state hints (e.g. `<Kbd>⌘</Kbd><Kbd>K</Kbd>`).
 *
 * Matches the `.kbd` utility in globals.css so it's visually consistent
 * with existing keyboard overlays.
 */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <kbd className={cn("kbd", className)}>{children}</kbd>;
}

/**
 * Render a space-separated chord — e.g. `"g d"` for "g then d" — as a
 * row of `<Kbd>` pills. Used by the keyboard overlay and in empty-state
 * CTAs. Preserves modifier glyphs like `⌘`, `⇧`, `⌥`, `⌃`, `⏎`.
 */
export function Chord({
  chord,
  separator,
  className,
}: {
  chord: string;
  /** Optional separator rendered between keys (e.g. `"then"`). */
  separator?: ReactNode;
  className?: string;
}) {
  const parts = chord
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <span className={cn("inline-flex items-center gap-1 align-middle", className)}>
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && separator !== undefined && (
            <span className="text-[0.6875rem] text-muted-foreground">{separator}</span>
          )}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}
