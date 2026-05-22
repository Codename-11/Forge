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
 */
export function Tooltip({
  content,
  children,
}: {
  content: string;
  children: ReactElement<{ title?: string }>;
}) {
  if (!isValidElement(children)) return children;
  return cloneElement(children, { title: content });
}
