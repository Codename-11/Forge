import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, readDraft, saveDraft } from "../../src/components/ui/modal/draft";

/**
 * `draft.ts` is the small `localStorage` wrapper shared by `<QuickForm>`,
 * the quick-create floating bar, and (since this wave) the issue-detail
 * comment composer. The helper is best-effort — it must never throw —
 * and entries older than 24h are GC'd on read.
 */

// Minimal in-memory Storage shim. Mirrors the surface area the helper
// actually touches: getItem / setItem / removeItem.
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

describe("modal draft helper", () => {
  let storage: ReturnType<typeof makeMemoryStorage>;

  beforeEach(() => {
    storage = makeMemoryStorage();
    // The helper reads `window.localStorage` lazily on each call, so a
    // global stub on `window` is enough — no module reset needed.
    vi.stubGlobal("window", { localStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("round-trips a string draft", () => {
    saveDraft("comment:issue-1", "Hello world");
    expect(readDraft<string>("comment:issue-1")).toBe("Hello world");
  });

  it("round-trips an object draft", () => {
    saveDraft("quickCreate", { text: "Fix bug", mode: "issue" });
    expect(readDraft<{ text: string; mode: string }>("quickCreate")).toEqual({
      text: "Fix bug",
      mode: "issue",
    });
  });

  it("returns null when no draft is stored", () => {
    expect(readDraft<string>("missing")).toBeNull();
  });

  it("clears a draft on demand", () => {
    saveDraft("k", "hello");
    expect(readDraft<string>("k")).toBe("hello");
    clearDraft("k");
    expect(readDraft<string>("k")).toBeNull();
  });

  it("GCs stale entries on read (older than 24h)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    saveDraft("stale", "yesterday");

    // 24h + 1ms later — should be evicted.
    vi.setSystemTime(new Date("2026-01-02T00:00:00.001Z"));
    expect(readDraft<string>("stale")).toBeNull();
    // The eviction also removes the underlying row.
    expect(storage._backing.has("forge.draft.stale")).toBe(false);
  });

  it("keeps fresh entries within 24h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    saveDraft("fresh", "today");

    // 23h 59m later — still fresh.
    vi.setSystemTime(new Date("2026-01-01T23:59:00Z"));
    expect(readDraft<string>("fresh")).toBe("today");
  });

  it("returns null and self-heals on malformed JSON", () => {
    // Inject a bad row directly — simulates a half-written quota event.
    storage.setItem("forge.draft.broken", "{not json");
    expect(readDraft<string>("broken")).toBeNull();
    expect(storage._backing.has("forge.draft.broken")).toBe(false);
  });

  it("returns null when window is undefined (SSR path)", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("window", undefined);
    expect(readDraft<string>("any")).toBeNull();
    // Save + clear stay silent (no throws).
    expect(() => saveDraft("any", "x")).not.toThrow();
    expect(() => clearDraft("any")).not.toThrow();
  });

  it("swallows storage exceptions on save (quota-exceeded etc.)", () => {
    vi.unstubAllGlobals();
    const failing: Storage = {
      ...makeMemoryStorage(),
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    vi.stubGlobal("window", { localStorage: failing });
    expect(() => saveDraft("k", "v")).not.toThrow();
  });

  it("namespaces keys under `forge.draft.`", () => {
    saveDraft("comment:issue-42", "body");
    expect(storage._backing.has("forge.draft.comment:issue-42")).toBe(true);
  });
});
