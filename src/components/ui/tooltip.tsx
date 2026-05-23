"use client";
import { cloneElement, isValidElement, type ReactElement } from "react";

/**
 * Tooltip — themed hover/focus label.
 *
 * Thin convenience over the global tooltip delegate (`NativeTooltips`,
 * mounted at the app root): it just sets `title` on its single child, which
 * the delegate then renders as a themed (non-native) tooltip. Using `title`
 * directly works identically — this wrapper exists for call-sites that
 * prefer an explicit component and for discoverability of the pattern.
 *
 * The child must forward `title` to a DOM node (plain elements, and most
 * `@/components/ui` primitives, do).
 *
 * ```tsx
 * <Tooltip content="Archive issue">
 *   <Button variant="ghost" size="icon"><Archive /></Button>
 * </Tooltip>
 * ```
 *
 * Pass `kbd` to surface a keyboard shortcut as `.kbd` chips inside the
 * themed tooltip. The value is a space-separated key list (e.g. `"⌘ K"` or
 * `"G D"`); it is set as `data-tooltip-kbd` and read by the delegate. Keep
 * `content` the human-readable label only — the shortcut lives in `kbd`.
 *
 * ```tsx
 * <Tooltip content="Search or jump" kbd="⌘ K">
 *   <button data-command-palette><Search /></button>
 * </Tooltip>
 * ```
 */
export function Tooltip({
  content,
  kbd,
  children,
}: {
  content: string;
  kbd?: string;
  children: ReactElement<{ title?: string; "data-tooltip-kbd"?: string }>;
}) {
  if (!isValidElement(children)) return children;
  return cloneElement(children, {
    title: content,
    ...(kbd ? { "data-tooltip-kbd": kbd } : {}),
  });
}
