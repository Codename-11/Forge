export const CHAT_LAST_SEEN_EVENT = "forge:chat:lastSeen";

export type ChatLastSeenMap = Record<string, number>;

export type ChatLastSeenEventDetail = {
  slug: string;
  threadId: string;
  seenAt: number;
};

export function chatLastSeenStorageKey(slug: string): string {
  return `forge.chat.lastSeen.${slug}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

export function readChatLastSeen(slug: string): ChatLastSeenMap {
  const store = storage();
  if (!store || !slug) return {};
  try {
    const raw = store.getItem(chatLastSeenStorageKey(slug));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ChatLastSeenMap = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        out[threadId] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeChatLastSeen(slug: string, value: ChatLastSeenMap): void {
  const store = storage();
  if (!store || !slug) return;
  try {
    store.setItem(chatLastSeenStorageKey(slug), JSON.stringify(value));
  } catch {
    /* best-effort browser read state */
  }
}

export function markChatThreadRead(slug: string, threadId: string, seenAt = Date.now()): void {
  if (!slug || !threadId) return;
  const current = readChatLastSeen(slug);
  const nextSeenAt = Math.max(current[threadId] ?? 0, seenAt);
  const next = { ...current, [threadId]: nextSeenAt };
  writeChatLastSeen(slug, next);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ChatLastSeenEventDetail>(CHAT_LAST_SEEN_EVENT, {
        detail: { slug, threadId, seenAt: nextSeenAt },
      }),
    );
  }
}
