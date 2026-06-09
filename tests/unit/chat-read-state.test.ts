import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_LAST_SEEN_EVENT,
  chatLastSeenStorageKey,
  markChatThreadRead,
  readChatLastSeen,
  writeChatLastSeen,
} from "@/lib/chat-read-state";

function makeMemoryStorage(): Storage & { _backing: Map<string, string> } {
  const backing = new Map<string, string>();
  return {
    _backing: backing,
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key) {
      return backing.has(key) ? backing.get(key)! : null;
    },
    key(i) {
      return Array.from(backing.keys())[i] ?? null;
    },
    removeItem(key) {
      backing.delete(key);
    },
    setItem(key, value) {
      backing.set(key, String(value));
    },
  };
}

describe("chat read-state helper", () => {
  let storage: ReturnType<typeof makeMemoryStorage>;
  let events: Array<{ type: string; detail?: unknown }>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    events = [];
    class TestCustomEvent<T = unknown> extends Event {
      detail: T;
      constructor(type: string, init?: CustomEventInit<T>) {
        super(type);
        this.detail = init?.detail as T;
      }
    }
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    vi.stubGlobal("window", {
      localStorage: storage,
      dispatchEvent(event: Event) {
        events.push({
          type: event.type,
          detail: (event as CustomEvent).detail,
        });
        return true;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips the workspace-scoped map", () => {
    writeChatLastSeen("forge", { thread_a: 10, thread_b: 20 });

    expect(storage._backing.has(chatLastSeenStorageKey("forge"))).toBe(true);
    expect(readChatLastSeen("forge")).toEqual({ thread_a: 10, thread_b: 20 });
  });

  it("marks a thread read without moving timestamps backwards", () => {
    writeChatLastSeen("forge", { thread_a: 100 });

    markChatThreadRead("forge", "thread_a", 50);
    markChatThreadRead("forge", "thread_b", 200);

    expect(readChatLastSeen("forge")).toEqual({ thread_a: 100, thread_b: 200 });
    expect(events).toEqual([
      {
        type: CHAT_LAST_SEEN_EVENT,
        detail: { slug: "forge", threadId: "thread_a", seenAt: 100 },
      },
      {
        type: CHAT_LAST_SEEN_EVENT,
        detail: { slug: "forge", threadId: "thread_b", seenAt: 200 },
      },
    ]);
  });

  it("ignores malformed stored data", () => {
    storage.setItem(chatLastSeenStorageKey("forge"), "{nope");

    expect(readChatLastSeen("forge")).toEqual({});
  });
});
