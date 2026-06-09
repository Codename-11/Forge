"use client";

import { useCallback, useEffect, useRef } from "react";
import { markChatThreadRead } from "@/lib/chat-read-state";
import { trpc } from "@/lib/trpc";

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  return Number.isFinite(time) ? time : null;
}

export function useChatThreadReadMarker({
  slug,
  threadId,
  latestMessageAt,
  enabled = true,
}: {
  slug: string | null | undefined;
  threadId: string | null | undefined;
  latestMessageAt?: Date | string | null;
  enabled?: boolean;
}) {
  const utils = trpc.useUtils();
  const lastEffectMarkerRef = useRef<string | null>(null);
  const lastSentAtRef = useRef<Record<string, number>>({});
  const markReadM = trpc.chat.markRead.useMutation({
    onSuccess: (result) => {
      const readAt = result.readAt;
      const patch = <T extends { id: string; lastReadAt?: Date | string | null }>(
        thread: T,
      ): T => (thread.id === result.threadId ? { ...thread, lastReadAt: readAt } : thread);

      utils.chat.threads.setData(undefined, (old) => old?.map(patch));
    },
  });

  const markRead = useCallback(
    (nextThreadId: string | null | undefined, seenAt = Date.now()) => {
      if (!enabled || !slug || !nextThreadId) return;
      const seenAtMs = typeof seenAt === "number" ? seenAt : Date.now();
      markChatThreadRead(slug, nextThreadId, seenAtMs);

      const lastSentAt = lastSentAtRef.current[nextThreadId] ?? 0;
      if (seenAtMs <= lastSentAt) return;
      lastSentAtRef.current[nextThreadId] = seenAtMs;
      markReadM.mutate({ threadId: nextThreadId, readAt: new Date(seenAtMs) });
    },
    [enabled, markReadM, slug],
  );

  useEffect(() => {
    if (!enabled || !threadId) return;
    const latestMs = toTime(latestMessageAt);
    const marker = `${threadId}:${latestMs ?? "open"}`;
    if (lastEffectMarkerRef.current === marker) return;
    lastEffectMarkerRef.current = marker;
    markRead(threadId);
  }, [enabled, latestMessageAt, markRead, threadId]);

  return markRead;
}
