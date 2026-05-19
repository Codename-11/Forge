"use client";
import { useEffect, useMemo, useId } from "react";
import { usePathname } from "next/navigation";
import { useChatContextRegistry, type ChatContextSnapshot } from "@/contexts/chat-context-provider";
import { useMaybeWorkspace } from "@/hooks/use-workspace";

/**
 * Build the current chat context bundle. Pure read — for sending with
 * a chat message. Pages can also `useChatContextRegister(snapshot)` to
 * push their state up.
 */
export function useChatContext(): ChatContextSnapshot {
  const { registered } = useChatContextRegistry();
  const pathname = usePathname();
  const workspace = useMaybeWorkspace();

  return useMemo(
    () => ({
      ...registered,
      route: registered.route ?? pathname ?? undefined,
      slug: workspace?.slug,
    }),
    [registered, pathname, workspace?.slug],
  );
}

/**
 * Page-level helper: register `snapshot` for the lifetime of the
 * component. Use stable refs in the deps to avoid re-registering every
 * render — pass primitive values, not objects.
 */
export function useChatContextRegister(snapshot: ChatContextSnapshot): void {
  const { register } = useChatContextRegistry();
  const id = useId();
  // Stringify is fine for our small snapshots — keeps the effect stable
  // when callers pass new object refs but identical content.
  const key = JSON.stringify(snapshot);
  useEffect(() => {
    return register(id, snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, register]);
}

export function formatChatContextSummary(context: ChatContextSnapshot): string[] {
  const items: string[] = [];
  if (context.route)
    items.push(`route:${context.route.replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")}`);
  if (context.issueId) items.push(`issue:${context.issueId}`);
  if (context.selectedIds?.length) items.push(`selected:${context.selectedIds.length}`);
  const visibleCount =
    context.visibleEntities?.reduce((sum, entity) => sum + entity.ids.length, 0) ?? 0;
  if (visibleCount) items.push(`visible:${visibleCount}`);
  if (context.pinnedRunIds?.length) items.push(`pinned-runs:${context.pinnedRunIds.length}`);
  if (context.liveRunIds?.length) items.push(`live-runs:${context.liveRunIds.length}`);
  if (context.slug) items.push(`workspace:${context.slug}`);
  return items;
}
